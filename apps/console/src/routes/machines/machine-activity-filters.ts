import type { AuditTimelineEntry } from "@/api/audit";
import type { DirectoryPerson } from "@/api/people-directory";

/**
 * The Activity tab's filter logic, kept out of the component so it can be
 * tested on its own — the same split `machine-compatibility.ts` gets from
 * `machine-size-browser.tsx`.
 *
 * These run over the events already loaded, not over the server. The fetch is
 * already narrowed to one machine (`useMachineActivity`), so a page or two is
 * usually its whole history, and filtering in place costs no round trip per
 * keystroke. The tab says so when more pages remain.
 */

/** Event domain (the part before the dot) → how it reads in the picker. Every
 * domain in `packages/events` is listed, including the ones that rarely carry a
 * machineId, so a machine that does emit one never falls through to the raw
 * slug. Order is fixed: machine first because it's the bulk of any machine's
 * feed, then the domains that attach to a machine, then the org-level ones. */
export const DOMAIN_LABEL: Record<string, string> = {
  machine: "Machine",
  access: "Access",
  snapshot: "Snapshot",
  agent: "Agent",
  cloud: "Cloud",
  approval: "Approval",
  org: "Org",
  person: "Person",
};
const DOMAIN_ORDER = Object.keys(DOMAIN_LABEL);

/** Non-person actor kinds, as they read in the picker. `person` is excluded on
 * purpose — those are offered individually by email, since "which person" is
 * the question this filter exists to answer. */
export const ACTOR_KIND_LABEL: Record<string, string> = {
  system: "System",
  agent: "Agent",
  idp: "IdP",
};

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** Fixed-length units carry their own milliseconds; `months` is null because a
 * month has no fixed length and is walked on the calendar instead — see
 * `timeCutoff`. */
export const TIME_UNITS = {
  minutes: { label: "minutes", ms: 60 * 1000 },
  hours: { label: "hours", ms: 60 * 60 * 1000 },
  days: { label: "days", ms: 24 * 60 * 60 * 1000 },
  weeks: { label: "weeks", ms: 7 * 24 * 60 * 60 * 1000 },
  months: { label: "months", ms: null },
} as const;
export type TimeUnit = keyof typeof TIME_UNITS;

/** `amount: null` means no time constraint at all. The unit survives a clear so
 * reopening the menu doesn't silently reset what you last picked. */
export interface TimeFilter {
  amount: number | null;
  unit: TimeUnit;
}

export const ANY_TIME: TimeFilter = { amount: null, unit: "days" };

/** The one-click windows. Anything else is typed into the amount field. */
export const TIME_PRESETS: { label: string; value: TimeFilter }[] = [
  { label: "Any time", value: ANY_TIME },
  { label: "24 hours", value: { amount: 24, unit: "hours" } },
  { label: "7 days", value: { amount: 7, unit: "days" } },
  { label: "30 days", value: { amount: 30, unit: "days" } },
];

export function isSameTimeFilter(a: TimeFilter, b: TimeFilter): boolean {
  // Two "any time"s are equal whatever unit each is parked on — the unit is
  // only remembered for the amount field, and on its own narrows nothing.
  if (a.amount === null || b.amount === null) return a.amount === b.amount;
  return a.amount === b.amount && a.unit === b.unit;
}

/**
 * The earliest `occurredAt` a filter admits, or null for no constraint.
 *
 * Months walk the calendar rather than multiplying out a 30-day average: "last
 * 3 months" asked in March means back to December, not back to 90 days ago, and
 * the two differ by up to three days depending on where in the year you ask.
 */
export function timeCutoff(time: TimeFilter, now: number): number | null {
  if (time.amount === null || !Number.isFinite(time.amount) || time.amount <= 0) return null;
  const unit = TIME_UNITS[time.unit];
  if (unit.ms !== null) return now - time.amount * unit.ms;
  const date = new Date(now);
  date.setMonth(date.getMonth() - time.amount);
  return date.getTime();
}

/** How a set time filter reads back in its section header. */
export function describeTimeFilter(time: TimeFilter): string | null {
  if (time.amount === null) return null;
  const preset = TIME_PRESETS.find(
    (candidate) => candidate.value.amount !== null && isSameTimeFilter(candidate.value, time),
  );
  if (preset) return preset.label;
  const plural = TIME_UNITS[time.unit].label;
  // "Last 1 days" is worth the one line it takes to avoid.
  return `Last ${time.amount} ${time.amount === 1 ? plural.replace(/s$/, "") : plural}`;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/** One selected event type, always exact. A domain row in the picker is a
 * select-all over its group, not a selector of its own, so no two stored values
 * ever overlap and "what is selected" has exactly one reading. */
export type TypeSelection = string;
/** `person:<personId>` or `kind:<actorType>`. */
export type ActorSelection = string;

export interface ActivityFilters {
  search: string;
  /** Empty means every type. Otherwise an event matches if it is any of these. */
  types: TypeSelection[];
  /** Empty means anyone. Otherwise an event matches if its actor is any of these. */
  actors: ActorSelection[];
  time: TimeFilter;
}

export const NO_FILTERS: ActivityFilters = {
  search: "",
  types: [],
  actors: [],
  time: ANY_TIME,
};

export function domainOf(type: string): string {
  return type.split(".")[0] ?? type;
}

export function domainLabel(domain: string): string {
  return DOMAIN_LABEL[domain] ?? domain;
}

/** The selector an entry's actor would be stored as. */
export function actorSelectionOf(entry: AuditTimelineEntry): ActorSelection {
  return entry.actorType === "person" ? `person:${entry.actorId ?? ""}` : `kind:${entry.actorType}`;
}

/** How many filters are narrowing the list — drives the badge on the Filters
 * button and whether the "no match" empty state offers a way out. A search of
 * only whitespace matches everything, so it doesn't count. A dimension counts
 * once however many values it holds: the badge answers "how much is narrowed",
 * not "how many boxes are ticked". */
export function activeFilterCount(filters: ActivityFilters): number {
  return (
    (filters.types.length > 0 ? 1 : 0) +
    (filters.actors.length > 0 ? 1 : 0) +
    (filters.time.amount === null ? 0 : 1) +
    (filters.search.trim() ? 1 : 0)
  );
}

/**
 * `now` is passed in rather than read from `Date.now()` so the time cutoff is
 * one fixed instant for a whole pass, and so a test can pin it.
 */
export function matchesActivityFilters(
  entry: AuditTimelineEntry,
  filters: ActivityFilters,
  now: number,
): boolean {
  const needle = filters.search.trim().toLowerCase();
  if (
    needle &&
    !entry.summary.toLowerCase().includes(needle) &&
    !entry.type.toLowerCase().includes(needle)
  ) {
    return false;
  }

  if (filters.types.length > 0 && !filters.types.includes(entry.type)) return false;
  if (filters.actors.length > 0 && !filters.actors.includes(actorSelectionOf(entry))) return false;

  // `occurredAt` (when it happened), not `recordedAt` (when we heard about it)
  // — "last 24 hours" is a question about the machine, not about ingestion.
  const cutoff = timeCutoff(filters.time, now);
  if (cutoff !== null && new Date(entry.occurredAt).getTime() < cutoff) return false;

  return true;
}

export function filterActivity(
  entries: AuditTimelineEntry[],
  filters: ActivityFilters,
  now: number = Date.now(),
): AuditTimelineEntry[] {
  return entries.filter((entry) => matchesActivityFilters(entry, filters, now));
}

/** Add or drop one value, keeping order of first selection so the stored list
 * doesn't reshuffle under the cursor as boxes are ticked. */
export function toggleSelection(current: string[], value: string): string[] {
  return current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
}

/** Tick-all / untick-all for one group. Ticking adds only what's missing, so it
 * never duplicates; unticking removes exactly that group and leaves the rest. */
export function toggleGroup(current: string[], values: string[], select: boolean): string[] {
  if (!select) return current.filter((v) => !values.includes(v));
  return [...current, ...values.filter((v) => !current.includes(v))];
}

export type GroupState = "none" | "some" | "all";

export function groupState(current: string[], values: string[]): GroupState {
  const picked = values.filter((v) => current.includes(v)).length;
  if (picked === 0) return "none";
  return picked === values.length ? "all" : "some";
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface TypeGroup {
  domain: string;
  types: string[];
}

/**
 * The event picker's options, grouped by domain.
 *
 * Derived from everything loaded, never from the filtered result — options that
 * vanish as you narrow leave you unable to widen again without clearing.
 */
export function deriveTypeGroups(entries: AuditTimelineEntry[]): TypeGroup[] {
  const byDomain = new Map<string, Set<string>>();
  for (const entry of entries) {
    const domain = domainOf(entry.type);
    const types = byDomain.get(domain) ?? new Set<string>();
    types.add(entry.type);
    byDomain.set(domain, types);
  }
  const rank = (domain: string) => {
    const i = DOMAIN_ORDER.indexOf(domain);
    // An unlisted domain (a future catalogue addition) sorts last rather than
    // to the front on indexOf's -1.
    return i === -1 ? DOMAIN_ORDER.length : i;
  };
  return [...byDomain.entries()]
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([domain, types]) => ({ domain, types: [...types].sort() }));
}

export interface ActorOption {
  /** The stored selector, e.g. `person:abc` or `kind:system`. */
  value: ActorSelection;
  label: string;
}

export interface ActorOptions {
  persons: ActorOption[];
  kinds: ActorOption[];
}

/** Person actors resolve to an email through the people directory, the same
 * lookup `ActorCell` does — a bare personId doesn't answer "who did this". */
export function deriveActorOptions(
  entries: AuditTimelineEntry[],
  people: DirectoryPerson[] | undefined,
): ActorOptions {
  const personIds = new Set<string>();
  const kinds = new Set<string>();
  for (const entry of entries) {
    if (entry.actorType === "person") {
      if (entry.actorId) personIds.add(entry.actorId);
    } else {
      kinds.add(entry.actorType);
    }
  }
  return {
    persons: [...personIds]
      .map((id) => ({
        value: `person:${id}`,
        label: people?.find((person) => person.id === id)?.email ?? id,
      }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    kinds: Object.keys(ACTOR_KIND_LABEL)
      .filter((kind) => kinds.has(kind))
      .map((kind) => ({ value: `kind:${kind}`, label: ACTOR_KIND_LABEL[kind] ?? kind })),
  };
}

// ---------------------------------------------------------------------------
// Facet counts
// ---------------------------------------------------------------------------

export type FilterDimension = keyof ActivityFilters;

/**
 * Everything that passes every filter EXCEPT one.
 *
 * This is what a facet count is counted over. Counting a dimension's options
 * against its own current value would make every unticked option read 0, which
 * says nothing; counting them against the *other* filters answers the question
 * you actually have with the menu open — "if I tick this too, what do I get".
 */
export function filterActivityExcept(
  entries: AuditTimelineEntry[],
  filters: ActivityFilters,
  except: FilterDimension,
  now: number = Date.now(),
): AuditTimelineEntry[] {
  return filterActivity(entries, { ...filters, [except]: NO_FILTERS[except] }, now);
}

export interface TypeFacets {
  /** Matching with no type constraint at all. */
  total: number;
  byDomain: Record<string, number>;
  byType: Record<string, number>;
}

export function deriveTypeFacets(
  entries: AuditTimelineEntry[],
  filters: ActivityFilters,
  now: number = Date.now(),
): TypeFacets {
  const scope = filterActivityExcept(entries, filters, "types", now);
  const byDomain: Record<string, number> = {};
  const byType: Record<string, number> = {};
  for (const item of scope) {
    const domain = domainOf(item.type);
    byDomain[domain] = (byDomain[domain] ?? 0) + 1;
    byType[item.type] = (byType[item.type] ?? 0) + 1;
  }
  return { total: scope.length, byDomain, byType };
}

export interface ActorFacets {
  /** Matching with no actor constraint at all. */
  total: number;
  /** Keyed by the same selector the filter stores. */
  byActor: Record<string, number>;
}

export function deriveActorFacets(
  entries: AuditTimelineEntry[],
  filters: ActivityFilters,
  now: number = Date.now(),
): ActorFacets {
  const scope = filterActivityExcept(entries, filters, "actors", now);
  const byActor: Record<string, number> = {};
  for (const item of scope) {
    const key = actorSelectionOf(item);
    byActor[key] = (byActor[key] ?? 0) + 1;
  }
  return { total: scope.length, byActor };
}

/** Count for each candidate window, against every other filter — lets the
 * preset chips show what each holds before you commit to it. */
export function deriveTimeFacets(
  entries: AuditTimelineEntry[],
  filters: ActivityFilters,
  candidates: TimeFilter[],
  now: number = Date.now(),
): number[] {
  const scope = filterActivityExcept(entries, filters, "time", now);
  return candidates.map((candidate) => {
    const cutoff = timeCutoff(candidate, now);
    if (cutoff === null) return scope.length;
    return scope.filter((item) => new Date(item.occurredAt).getTime() >= cutoff).length;
  });
}

// ---------------------------------------------------------------------------
// Read-back labels
// ---------------------------------------------------------------------------

/** What the Event dropdown's trigger says. One selection names itself; several
 * are counted, since a menu button is not the place to list them. */
export function describeTypes(types: TypeSelection[]): string {
  if (types.length === 0) return "All events";
  if (types.length === 1) return types[0] ?? "All events";
  return `${types.length} event types`;
}

export function describeActors(actors: ActorSelection[], options: ActorOptions): string {
  if (actors.length === 0) return "Anyone";
  if (actors.length === 1) {
    const only = actors[0] ?? "";
    const match = [...options.persons, ...options.kinds].find((option) => option.value === only);
    // An actor no longer among the loaded events still reads back as its own id
    // rather than as an empty button.
    return match?.label ?? only.replace(/^(person|kind):/, "");
  }
  return `${actors.length} actors`;
}
