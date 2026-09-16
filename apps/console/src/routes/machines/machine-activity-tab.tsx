import {
  Clock,
  FileText,
  History,
  Loader2,
  Search,
  SlidersHorizontal,
  User,
  Zap,
} from "lucide-react";
import { useMemo, useState } from "react";

import { type AuditTimelineEntry, useMachineActivity } from "@/api/audit";
import type { DirectoryPerson } from "@/api/people-directory";
import { ActorCell } from "@/components/actor-cell";
import { Freshness } from "@/components/freshness";
import { TableHeaderIcon } from "@/components/table-header-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import {
  ACTOR_KIND_LABEL,
  type ActivityFilters,
  NO_FILTERS,
  TIME_RANGES,
  type TimeRange,
  activeFilterCount,
  deriveActorOptions,
  deriveTypeGroups,
  domainLabel,
  filterActivity,
} from "./machine-activity-filters";

/**
 * A machine's Activity tab: its own slice of the append-only event log, newest
 * first, with a filter bar over it.
 *
 * Split out of `machine-detail-page.tsx` (which already hands Manifest its own
 * file) once it grew a query, four filters and pagination of its own.
 *
 * The filters run over what's been loaded, not over the server — the fetch is
 * already narrowed to this machine, so a page or two is usually the machine's
 * whole history, and filtering in place means no round trip per keystroke. Where
 * that isn't true the footer says so rather than letting an empty result imply
 * the events don't exist.
 */
export function MachineActivityTab({
  machineId,
  people,
}: {
  machineId: string;
  people: DirectoryPerson[] | undefined;
}) {
  const query = useMachineActivity(machineId);

  const [filters, setFilters] = useState<ActivityFilters>(NO_FILTERS);
  const setFilter = <K extends keyof ActivityFilters>(key: K, value: ActivityFilters[K]) =>
    setFilters((current) => ({ ...current, [key]: value }));

  const entries = useMemo(
    () => query.data?.pages.flatMap((page) => page.entries) ?? [],
    [query.data],
  );

  const typeGroups = useMemo(() => deriveTypeGroups(entries), [entries]);
  const actorOptions = useMemo(() => deriveActorOptions(entries, people), [entries, people]);
  const filtered = useMemo(() => filterActivity(entries, filters), [entries, filters]);

  const filterCount = activeFilterCount(filters);
  const clearFilters = () => setFilters(NO_FILTERS);

  if (query.isPending) {
    return (
      <Card>
        <CardContent className="p-0">
          <ActivityTable>
            {Array.from({ length: 6 }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed-count skeleton placeholder rows, never reordered.
              <TableRow key={i}>
                <TableCell>
                  <Skeleton className="h-4 w-36" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-4 w-64" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-4 w-24" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-4 w-16" />
                </TableCell>
              </TableRow>
            ))}
          </ActivityTable>
        </CardContent>
      </Card>
    );
  }

  if (query.isError) {
    return (
      <Card>
        <CardContent className="p-0">
          <ActivityTable>
            <TableRow>
              <TableCell colSpan={4} className="text-center text-destructive">
                Failed to load activity.
              </TableCell>
            </TableRow>
          </ActivityTable>
        </CardContent>
      </Card>
    );
  }

  // Settled with nothing on record. No toolbar: there is nothing to filter, and
  // a filter bar over an empty table reads as though the filters caused it.
  if (entries.length === 0) {
    return (
      <Card>
        <CardContent className="p-0">
          <EmptyState
            icon={History}
            title="No recorded events yet"
            description="Events for this machine will appear here as they happen."
          />
        </CardContent>
      </Card>
    );
  }

  const countSummary =
    filterCount > 0
      ? `${filtered.length.toLocaleString()} of ${entries.length.toLocaleString()} events`
      : `${entries.length.toLocaleString()} ${entries.length === 1 ? "event" : "events"}`;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-40 max-w-xs flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filters.search}
            onChange={(event) => setFilter("search", event.target.value)}
            placeholder="Search summary or event type…"
            className="pl-8"
          />
        </div>

        <Popover>
          <PopoverTrigger asChild>
            <Button type="button" variant="outline" size="sm" className="gap-1.5">
              <SlidersHorizontal className="size-3.5" />
              Filters
              {filterCount > 0 && (
                <Badge variant="secondary" className="h-4 min-w-4 rounded-full px-1 text-xs">
                  {filterCount}
                </Badge>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="flex w-64 flex-col gap-4" align="start">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="activity-type">Event</Label>
              <Select value={filters.type} onValueChange={(value) => setFilter("type", value)}>
                <SelectTrigger id="activity-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All events</SelectItem>
                  {typeGroups.map(({ domain, types }) => (
                    <SelectGroup key={domain}>
                      <SelectSeparator />
                      <SelectLabel>{domainLabel(domain)}</SelectLabel>
                      {/* The whole domain in one click — most of the time you
                          want "everything access-related", not one exact type. */}
                      <SelectItem value={`domain:${domain}`}>
                        All {domainLabel(domain).toLowerCase()} events
                      </SelectItem>
                      {types.map((type) => (
                        <SelectItem key={type} value={`type:${type}`}>
                          {type}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="activity-actor">Actor</Label>
              <Select value={filters.actor} onValueChange={(value) => setFilter("actor", value)}>
                <SelectTrigger id="activity-actor">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Anyone</SelectItem>
                  {actorOptions.persons.length > 0 && (
                    <SelectGroup>
                      <SelectSeparator />
                      <SelectLabel>People</SelectLabel>
                      {actorOptions.persons.map((person) => (
                        <SelectItem key={person.id} value={`person:${person.id}`}>
                          {person.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                  {actorOptions.kinds.length > 0 && (
                    <SelectGroup>
                      <SelectSeparator />
                      <SelectLabel>Not a person</SelectLabel>
                      {actorOptions.kinds.map((kind) => (
                        <SelectItem key={kind} value={`kind:${kind}`}>
                          {ACTOR_KIND_LABEL[kind]}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="activity-time">When</Label>
              <Select
                value={filters.time}
                onValueChange={(value) => setFilter("time", value as TimeRange)}
              >
                <SelectTrigger id="activity-time">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(TIME_RANGES).map(([value, range]) => (
                    <SelectItem key={value} value={value}>
                      {range.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </PopoverContent>
        </Popover>

        {filterCount > 0 && (
          <Button type="button" variant="ghost" size="sm" onClick={clearFilters}>
            Clear
          </Button>
        )}

        <span className="ml-auto text-xs text-muted-foreground">{countSummary}</span>
      </div>

      <Card>
        <CardContent className="p-0">
          {filtered.length > 0 ? (
            <ActivityTable>
              {filtered.map((entry) => (
                <ActivityRow key={entry.id} entry={entry} people={people} />
              ))}
            </ActivityTable>
          ) : (
            // Distinct from "no recorded events yet" above: the machine has a
            // history, this view of it is empty. Saying so, with the way out
            // attached, is the difference between a dead end and a filter.
            <div className="flex flex-col items-center gap-4 py-4">
              <EmptyState
                icon={Search}
                title="No events match these filters"
                description="Widen the filters, or clear them to see this machine's full history."
              />
              <Button type="button" variant="outline" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {query.hasNextPage && (
        <div className="flex flex-col items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={query.isFetchingNextPage}
            onClick={() => query.fetchNextPage()}
          >
            {query.isFetchingNextPage && <Loader2 className="size-3.5 animate-spin" />}
            {query.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
          {filterCount > 0 && (
            // The filters only see what's loaded. Left unsaid, an empty result
            // would read as "this never happened" rather than "not loaded yet".
            <p className="text-xs text-muted-foreground">
              Filters apply to the {entries.length.toLocaleString()} events loaded so far. Load more
              to search further back.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Column headers and shell, shared by the loading, error and loaded states so
 * the table doesn't shift shape between them. */
function ActivityTable({ children }: { children: React.ReactNode }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>
            <span className="flex items-center gap-1.5">
              <TableHeaderIcon icon={Zap} />
              Event
            </span>
          </TableHead>
          <TableHead>
            <span className="flex items-center gap-1.5">
              <TableHeaderIcon icon={FileText} />
              Summary
            </span>
          </TableHead>
          <TableHead>
            <span className="flex items-center gap-1.5">
              <TableHeaderIcon icon={User} />
              Actor
            </span>
          </TableHead>
          <TableHead>
            <span className="flex items-center gap-1.5">
              <TableHeaderIcon icon={Clock} />
              When
            </span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>{children}</TableBody>
    </Table>
  );
}

/** align-top on every cell: Summary regularly wraps to several lines while the
 * other three stay single-line, and centering those against a multi-line
 * neighbour leaves them floating off their own row's first line. Same treatment
 * the org-wide timeline uses (`routes/audit/audit-page.tsx`). */
function ActivityRow({
  entry,
  people,
}: {
  entry: AuditTimelineEntry;
  people: DirectoryPerson[] | undefined;
}) {
  return (
    <TableRow>
      <TableCell className="align-top">
        <code className="font-mono text-xs text-muted-foreground">{entry.type}</code>
      </TableCell>
      <TableCell className="max-w-md align-top">{entry.summary}</TableCell>
      <TableCell className="whitespace-nowrap align-top text-sm">
        <ActorCell entry={entry} people={people} />
      </TableCell>
      <TableCell className="whitespace-nowrap align-top">
        <Freshness occurredAt={entry.occurredAt} recordedAt={entry.recordedAt} />
      </TableCell>
    </TableRow>
  );
}
