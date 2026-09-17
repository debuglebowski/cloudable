import {
  Check,
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
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

import {
  ACTOR_KIND_LABEL,
  type ActivityFilters,
  NO_FILTERS,
  TIME_RANGES,
  type TimeRange,
  activeFilterCount,
  deriveActorFacets,
  deriveActorOptions,
  deriveTimeFacets,
  deriveTypeFacets,
  deriveTypeGroups,
  describeActorFilter,
  describeTypeFilter,
  domainLabel,
  filterActivity,
} from "./machine-activity-filters";

/**
 * A machine's Activity tab, split in two because the halves render in different
 * places: the toolbar sits in the detail page's tab row, right-aligned opposite
 * the tabs themselves, and the table sits in the tab panel below.
 *
 * `useMachineActivityState` is what joins them. A hook plus two components,
 * rather than a context provider, because there is exactly one consumer —
 * threading one object through two props is less machinery than a provider.
 */
export function useMachineActivityState(
  machineId: string,
  people: DirectoryPerson[] | undefined,
  enabled: boolean,
) {
  const query = useMachineActivity(machineId, enabled);
  const [filters, setFilters] = useState<ActivityFilters>(NO_FILTERS);

  const entries = useMemo(
    () => query.data?.pages.flatMap((page) => page.entries) ?? [],
    [query.data],
  );
  const filtered = useMemo(() => filterActivity(entries, filters), [entries, filters]);

  return { query, filters, setFilters, entries, filtered, people };
}

type ActivityState = ReturnType<typeof useMachineActivityState>;

// ---------------------------------------------------------------------------
// Toolbar — renders in the tab row
// ---------------------------------------------------------------------------

/**
 * Search plus a filter menu, sized to sit beside the tab pills.
 *
 * Renders nothing until there is something to filter. A toolbar over an empty
 * or still-loading table invites you to narrow a list with nothing in it, and
 * then the empty result reads as your own doing.
 */
export function MachineActivityToolbar({ state }: { state: ActivityState }) {
  const { query, filters, setFilters, entries, people } = state;

  const typeGroups = useMemo(() => deriveTypeGroups(entries), [entries]);
  const actorOptions = useMemo(() => deriveActorOptions(entries, people), [entries, people]);
  const typeFacets = useMemo(() => deriveTypeFacets(entries, filters), [entries, filters]);
  const actorFacets = useMemo(() => deriveActorFacets(entries, filters), [entries, filters]);
  const timeFacets = useMemo(() => deriveTimeFacets(entries, filters), [entries, filters]);

  const filterCount = activeFilterCount(filters);
  const setFilter = <K extends keyof ActivityFilters>(key: K, value: ActivityFilters[K]) =>
    setFilters((current) => ({ ...current, [key]: value }));

  if (query.isPending || query.isError || entries.length === 0) return null;

  return (
    <div className="flex items-center gap-2">
      <div className="relative w-56">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={filters.search}
          onChange={(event) => setFilter("search", event.target.value)}
          placeholder="Search activity…"
          aria-label="Search this machine's activity"
          className="h-9 rounded-full pl-8"
        />
      </div>

      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={filterCount > 0 ? `Filters, ${filterCount} active` : "Filters"}
            className={cn("h-9 gap-1.5 rounded-full", filterCount > 0 && "border-foreground/30")}
          >
            <SlidersHorizontal className="size-3.5" />
            Filters
            {filterCount > 0 && (
              <Badge className="h-4 min-w-4 rounded-full px-1 text-xs tabular-nums">
                {filterCount}
              </Badge>
            )}
          </Button>
        </PopoverTrigger>

        {/* Three sections of real content, not three dropdowns that each open a
            fourth layer. A Select inside a Popover means two nested portals and
            two Escape presses to get back out, and it hides every option behind
            one more click than it needs. */}
        <PopoverContent align="end" className="max-h-[70vh] w-80 overflow-y-auto p-0">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-sm font-medium">Filters</span>
            {filterCount > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="-mr-1.5 h-6 px-2 text-xs"
                onClick={() => setFilters(NO_FILTERS)}
              >
                Clear all
              </Button>
            )}
          </div>

          <FilterSection
            title="When"
            value={filters.time === "all" ? null : TIME_RANGES[filters.time].label}
            onClear={filters.time === "all" ? undefined : () => setFilter("time", "all")}
          >
            {/* Four fixed options, so segments rather than a list: every choice
                is visible and one click away, and the counts make the shape of
                the machine's history readable at a glance. A 2x2 grid, not a
                wrapping row — four labelled pills with counts overflow a 320px
                menu, and a deliberate grid reads better than a row that breaks
                three-and-one. */}
            <div className="grid grid-cols-2 gap-1">
              {(Object.keys(TIME_RANGES) as TimeRange[]).map((range) => (
                <button
                  key={range}
                  type="button"
                  onClick={() => setFilter("time", range)}
                  aria-pressed={filters.time === range}
                  className={cn(
                    "inline-flex items-center justify-between gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
                    filters.time === range
                      ? "bg-foreground text-background"
                      : "bg-accent text-muted-foreground hover:text-foreground",
                    // Same dimming an empty option row gets: a window holding
                    // nothing should look spent before you click it.
                    timeFacets[range] === 0 && filters.time !== range && "opacity-45",
                  )}
                >
                  {TIME_RANGES[range].short}
                  <span className="tabular-nums opacity-60">{timeFacets[range]}</span>
                </button>
              ))}
            </div>
          </FilterSection>

          <FilterSection
            title="Event"
            value={describeTypeFilter(filters.type)}
            onClear={filters.type === "all" ? undefined : () => setFilter("type", "all")}
          >
            <Command className="rounded-md border border-border">
              <CommandInput placeholder="Find an event type…" className="h-9" />
              <CommandList className="max-h-52">
                <CommandEmpty className="py-4 text-xs text-muted-foreground">
                  No event type by that name.
                </CommandEmpty>
                <CommandGroup>
                  <OptionRow
                    label="All events"
                    count={typeFacets.total}
                    selected={filters.type === "all"}
                    onSelect={() => setFilter("type", "all")}
                  />
                </CommandGroup>
                {typeGroups.map(({ domain, types }) => (
                  <CommandGroup key={domain} heading={domainLabel(domain)}>
                    <OptionRow
                      // The whole domain in one click — most of the time the
                      // question is "everything access-related", not one type.
                      label={`All ${domainLabel(domain).toLowerCase()} events`}
                      count={typeFacets.byDomain[domain] ?? 0}
                      selected={filters.type === `domain:${domain}`}
                      onSelect={() => setFilter("type", `domain:${domain}`)}
                    />
                    {types.map((type) => (
                      <OptionRow
                        key={type}
                        label={type}
                        mono
                        count={typeFacets.byType[type] ?? 0}
                        selected={filters.type === `type:${type}`}
                        onSelect={() => setFilter("type", `type:${type}`)}
                      />
                    ))}
                  </CommandGroup>
                ))}
              </CommandList>
            </Command>
          </FilterSection>

          <FilterSection
            title="Actor"
            value={describeActorFilter(filters.actor, actorOptions)}
            onClear={filters.actor === "all" ? undefined : () => setFilter("actor", "all")}
            last
          >
            {/* No search box here: a machine has a handful of actors, not the
                dozens of event types above, and an input over four rows is
                furniture. */}
            <Command className="rounded-md border border-border">
              <CommandList className="max-h-44">
                <CommandGroup>
                  <OptionRow
                    label="Anyone"
                    count={actorFacets.total}
                    selected={filters.actor === "all"}
                    onSelect={() => setFilter("actor", "all")}
                  />
                </CommandGroup>
                {actorOptions.persons.length > 0 && (
                  <CommandGroup heading="People">
                    {actorOptions.persons.map((person) => (
                      <OptionRow
                        key={person.id}
                        label={person.label}
                        count={actorFacets.byPerson[person.id] ?? 0}
                        selected={filters.actor === `person:${person.id}`}
                        onSelect={() => setFilter("actor", `person:${person.id}`)}
                      />
                    ))}
                  </CommandGroup>
                )}
                {actorOptions.kinds.length > 0 && (
                  <CommandGroup heading="Not a person">
                    {actorOptions.kinds.map((kind) => (
                      <OptionRow
                        key={kind}
                        label={ACTOR_KIND_LABEL[kind] ?? kind}
                        count={actorFacets.byKind[kind] ?? 0}
                        selected={filters.actor === `kind:${kind}`}
                        onSelect={() => setFilter("actor", `kind:${kind}`)}
                      />
                    ))}
                  </CommandGroup>
                )}
              </CommandList>
            </Command>
          </FilterSection>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** One labelled block of the filter menu. The header carries the dimension's
 * current value and its own clear button, so what is set is readable without
 * scrolling a list to find the tick, and undoing one filter doesn't mean
 * clearing all of them. */
function FilterSection({
  title,
  value,
  onClear,
  last,
  children,
}: {
  title: string;
  value: string | null;
  onClear?: (() => void) | undefined;
  last?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-2 px-3 py-3", !last && "border-b border-border")}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </span>
        {onClear ? (
          <button
            type="button"
            onClick={onClear}
            title={`Clear: ${value}`}
            className="max-w-[60%] truncate text-xs text-foreground underline-offset-2 hover:underline"
          >
            {value}
          </button>
        ) : (
          value && <span className="max-w-[60%] truncate text-xs">{value}</span>
        )}
      </div>
      {children}
    </div>
  );
}

/** A single-select row: tick on the left so the selection is scannable down one
 * column, count on the right. The count is what the list would hold if you
 * picked this — every other filter still applied — so a 0 tells you not to
 * bother rather than leaving you to find out by clicking. */
function OptionRow({
  label,
  count,
  selected,
  mono,
  onSelect,
}: {
  label: string;
  count: number;
  selected: boolean;
  mono?: boolean;
  onSelect: () => void;
}) {
  return (
    <CommandItem
      value={label}
      onSelect={onSelect}
      className={cn("cursor-pointer gap-2", count === 0 && !selected && "opacity-45")}
    >
      <Check className={cn("size-3.5 shrink-0", selected ? "opacity-100" : "opacity-0")} />
      <span className={cn("truncate", mono && "font-mono text-xs")}>{label}</span>
      <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">{count}</span>
    </CommandItem>
  );
}

// ---------------------------------------------------------------------------
// Panel — renders in the tab body
// ---------------------------------------------------------------------------

export function MachineActivityPanel({ state }: { state: ActivityState }) {
  const { query, filters, setFilters, entries, filtered, people } = state;
  const filterCount = activeFilterCount(filters);

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

  // Settled with nothing on record — distinct from "nothing matches", below.
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

  return (
    <div className="flex flex-col gap-2">
      {filterCount > 0 && (
        <p className="self-end text-xs tabular-nums text-muted-foreground">
          {filtered.length.toLocaleString()} of {entries.length.toLocaleString()} events
        </p>
      )}

      <Card>
        <CardContent className="p-0">
          {filtered.length > 0 ? (
            <ActivityTable>
              {filtered.map((entry) => (
                <ActivityRow key={entry.id} entry={entry} people={people} />
              ))}
            </ActivityTable>
          ) : (
            <div className="flex flex-col items-center gap-3 py-6">
              {/* py-10, not EmptyState's default py-16: the Clear button below
                  belongs to this message, and the default left a gap wide
                  enough to read as a separate thing. */}
              <EmptyState
                className="py-10"
                icon={Search}
                title="No events match these filters"
                description="Widen the filters, or clear them to see this machine's full history."
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setFilters(NO_FILTERS)}
              >
                Clear filters
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {query.hasNextPage && (
        <div className="flex flex-col items-center gap-1.5 pt-1">
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
