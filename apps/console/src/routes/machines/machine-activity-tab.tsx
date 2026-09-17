import {
  Check,
  ChevronDown,
  Clock,
  FileText,
  History,
  Loader2,
  Minus,
  Search,
  SlidersHorizontal,
  User,
  Zap,
} from "lucide-react";
import { forwardRef, useMemo, useState } from "react";

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
  ANY_TIME,
  type ActivityFilters,
  type ActorOptions,
  NO_FILTERS,
  TIME_PRESETS,
  TIME_UNITS,
  type TimeFilter,
  type TimeUnit,
  type TypeGroup,
  activeFilterCount,
  deriveActorFacets,
  deriveActorOptions,
  deriveTimeFacets,
  deriveTypeFacets,
  deriveTypeGroups,
  describeActors,
  describeTimeFilter,
  describeTypes,
  domainLabel,
  filterActivity,
  groupState,
  isSameTimeFilter,
  toggleGroup,
  toggleSelection,
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
  const presetFacets = useMemo(
    () =>
      deriveTimeFacets(
        entries,
        filters,
        TIME_PRESETS.map((preset) => preset.value),
      ),
    [entries, filters],
  );

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

        {/* Compact on purpose: Event and Actor are collapsed triggers rather than
            two open lists, which kept the menu around 600px tall and pushed Actor
            off the bottom on a laptop. Each opens its own list beside this one. */}
        <PopoverContent align="end" className="w-80 p-0">
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
            value={describeTimeFilter(filters.time)}
            onClear={filters.time.amount === null ? undefined : () => setFilter("time", ANY_TIME)}
          >
            <TimeField
              value={filters.time}
              counts={presetFacets}
              onChange={(next) => setFilter("time", next)}
            />
          </FilterSection>

          <FilterSection
            title="Event"
            value={filters.types.length > 0 ? describeTypes(filters.types) : null}
            onClear={filters.types.length === 0 ? undefined : () => setFilter("types", [])}
          >
            <EventDropdown
              groups={typeGroups}
              facets={typeFacets}
              selected={filters.types}
              onChange={(next) => setFilter("types", next)}
            />
          </FilterSection>

          <FilterSection
            title="Actor"
            value={filters.actors.length > 0 ? describeActors(filters.actors, actorOptions) : null}
            onClear={filters.actors.length === 0 ? undefined : () => setFilter("actors", [])}
            last
          >
            <ActorDropdown
              options={actorOptions}
              facets={actorFacets}
              selected={filters.actors}
              onChange={(next) => setFilter("actors", next)}
            />
          </FilterSection>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** Preset windows plus a free amount and unit, because "the last N of anything"
 * is a question the four chips can't answer and the machine you are looking at
 * decides which N matters. Typing an amount takes over from the chips; the
 * chips highlight again when the value matches one exactly. */
function TimeField({
  value,
  counts,
  onChange,
}: {
  value: TimeFilter;
  counts: number[];
  onChange: (next: TimeFilter) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-1">
        {TIME_PRESETS.map((preset, index) => {
          const active = isSameTimeFilter(preset.value, value);
          const count = counts[index] ?? 0;
          return (
            <button
              key={preset.label}
              type="button"
              onClick={() => onChange(preset.value)}
              aria-pressed={active}
              className={cn(
                "inline-flex items-center justify-between gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
                active
                  ? "bg-foreground text-background"
                  : "bg-accent text-muted-foreground hover:text-foreground",
                // Same dimming an empty option row gets: a window holding
                // nothing should look spent before you click it.
                count === 0 && !active && "opacity-45",
              )}
            >
              {preset.label}
              <span className="tabular-nums opacity-60">{count}</span>
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground">Last</span>
        <Input
          type="number"
          min={1}
          inputMode="numeric"
          aria-label="Amount of time"
          placeholder="any"
          value={value.amount ?? ""}
          onChange={(event) => {
            const raw = event.target.value.trim();
            const parsed = Number(raw);
            // An empty or nonsensical amount is "any time" rather than an error
            // state — there is nothing to get wrong, only a window to drop.
            onChange({
              ...value,
              amount: raw === "" || !Number.isFinite(parsed) || parsed <= 0 ? null : parsed,
            });
          }}
          className="h-8 w-16 text-xs"
        />
        <select
          aria-label="Unit of time"
          value={value.unit}
          onChange={(event) => onChange({ ...value, unit: event.target.value as TimeUnit })}
          className="h-8 flex-1 rounded-md border border-input bg-transparent px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {(Object.keys(TIME_UNITS) as TimeUnit[]).map((unit) => (
            <option key={unit} value={unit}>
              {TIME_UNITS[unit].label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

/** The collapsed trigger both pickers share: reads back what is selected, opens
 * the list beside the filter menu rather than inside it.
 *
 * forwardRef and a props spread, not a wrapping div: `PopoverTrigger asChild`
 * hands its ref and `aria-haspopup`/`aria-expanded` to whatever it clones, and
 * on a div those land on something a screen reader reads as neither a button
 * nor a thing that opens anything. */
const DropdownTrigger = forwardRef<
  HTMLButtonElement,
  { label: string; active: boolean } & React.ComponentPropsWithoutRef<typeof Button>
>(({ label, active, className, ...props }, ref) => (
  <Button
    ref={ref}
    type="button"
    variant="outline"
    className={cn(
      "h-8 w-full justify-between gap-2 px-2.5 text-xs font-normal",
      active && "border-foreground/30",
      className,
    )}
    {...props}
  >
    <span className="truncate">{label}</span>
    <ChevronDown className="size-3.5 shrink-0 opacity-50" />
  </Button>
));
DropdownTrigger.displayName = "DropdownTrigger";

function EventDropdown({
  groups,
  facets,
  selected,
  onChange,
}: {
  groups: TypeGroup[];
  facets: ReturnType<typeof deriveTypeFacets>;
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <DropdownTrigger
          label={describeTypes(selected)}
          active={selected.length > 0}
          aria-label={`Event types: ${describeTypes(selected)}`}
        />
      </PopoverTrigger>
      {/* side="left": this opens from inside another popover that is already
          pinned to the right edge of the page, so opening right would run the
          list off screen. */}
      <PopoverContent side="left" align="start" className="w-72 p-0">
        <Command>
          <CommandInput placeholder="Find an event type…" className="h-9" />
          <CommandList className="max-h-72">
            <CommandEmpty className="py-4 text-center text-xs text-muted-foreground">
              No event type by that name.
            </CommandEmpty>
            <CommandGroup>
              <OptionRow
                label="All events"
                count={facets.total}
                state={selected.length === 0 ? "all" : "none"}
                onSelect={() => onChange([])}
              />
            </CommandGroup>
            {groups.map(({ domain, types }) => {
              const state = groupState(selected, types);
              return (
                <CommandGroup key={domain} heading={domainLabel(domain)}>
                  <OptionRow
                    // Not a selector of its own — ticking it ticks every type
                    // under it, so what is stored never overlaps and the
                    // summary can be counted honestly.
                    label={`All ${domainLabel(domain).toLowerCase()} events`}
                    count={facets.byDomain[domain] ?? 0}
                    state={state}
                    onSelect={() => onChange(toggleGroup(selected, types, state !== "all"))}
                  />
                  {types.map((type) => (
                    <OptionRow
                      key={type}
                      label={type}
                      mono
                      count={facets.byType[type] ?? 0}
                      state={selected.includes(type) ? "all" : "none"}
                      onSelect={() => onChange(toggleSelection(selected, type))}
                    />
                  ))}
                </CommandGroup>
              );
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function ActorDropdown({
  options,
  facets,
  selected,
  onChange,
}: {
  options: ActorOptions;
  facets: ReturnType<typeof deriveActorFacets>;
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const manyPeople = options.persons.length > 8;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <DropdownTrigger
          label={describeActors(selected, options)}
          active={selected.length > 0}
          aria-label={`Actors: ${describeActors(selected, options)}`}
        />
      </PopoverTrigger>
      <PopoverContent side="left" align="start" className="w-72 p-0">
        <Command>
          {/* A search box over four rows is furniture; over a big org's people
              list it is the only way through. */}
          {manyPeople && <CommandInput placeholder="Find an actor…" className="h-9" />}
          <CommandList className="max-h-72">
            <CommandEmpty className="py-4 text-center text-xs text-muted-foreground">
              No actor by that name.
            </CommandEmpty>
            <CommandGroup>
              <OptionRow
                label="Anyone"
                count={facets.total}
                state={selected.length === 0 ? "all" : "none"}
                onSelect={() => onChange([])}
              />
            </CommandGroup>
            {options.persons.length > 0 && (
              <CommandGroup heading="People">
                {options.persons.map((option) => (
                  <OptionRow
                    key={option.value}
                    label={option.label}
                    count={facets.byActor[option.value] ?? 0}
                    state={selected.includes(option.value) ? "all" : "none"}
                    onSelect={() => onChange(toggleSelection(selected, option.value))}
                  />
                ))}
              </CommandGroup>
            )}
            {options.kinds.length > 0 && (
              <CommandGroup heading="Not a person">
                {options.kinds.map((option) => (
                  <OptionRow
                    key={option.value}
                    label={option.label}
                    count={facets.byActor[option.value] ?? 0}
                    state={selected.includes(option.value) ? "all" : "none"}
                    onSelect={() => onChange(toggleSelection(selected, option.value))}
                  />
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** One labelled block of the filter menu. The header carries the dimension's
 * current value and its own clear button, so what is set is readable without
 * opening the dropdown, and undoing one filter doesn't mean clearing all. */
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
        {onClear && (
          <button
            type="button"
            onClick={onClear}
            title={`Clear: ${value}`}
            className="max-w-[60%] shrink-0 truncate text-xs text-foreground underline-offset-2 hover:underline"
          >
            Clear
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

/** A multi-select row: box on the left so what is ticked is scannable down one
 * column, count on the right. The count is what the list would hold with this
 * also ticked — every other filter still applied — so a 0 tells you not to
 * bother rather than leaving you to find out by clicking.
 *
 * `state` is three-valued because a domain row is a tick-all over its group and
 * has to be able to say "some of these". */
function OptionRow({
  label,
  count,
  state,
  mono,
  onSelect,
}: {
  label: string;
  count: number;
  state: "none" | "some" | "all";
  mono?: boolean;
  onSelect: () => void;
}) {
  return (
    <CommandItem
      value={label}
      onSelect={onSelect}
      className={cn("cursor-pointer gap-2", count === 0 && state === "none" && "opacity-45")}
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
          state === "none"
            ? "border-muted-foreground/40"
            : "border-foreground bg-foreground text-background",
        )}
      >
        {state === "all" && <Check className="size-2.5" strokeWidth={3} />}
        {state === "some" && <Minus className="size-2.5" strokeWidth={3} />}
      </span>
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
