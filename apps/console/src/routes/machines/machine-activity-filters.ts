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

/** `label` is the full phrase, used where a filter is read back as a sentence
 * (the section header, the toolbar). `short` is for the segmented pills, which
 * sit four-across in a 320px menu and wrapped to a second line at full length. */
export const TIME_RANGES = {
  all: { label: "Any time", short: "Any time", ms: null },
  "24h": { label: "Last 24 hours", short: "24 hours", ms: 24 * 60 * 60 * 1000 },
  "7d": { label: "Last 7 days", short: "7 days", ms: 7 * 24 * 60 * 60 * 1000 },
  "30d": { label: "Last 30 days", short: "30 days", ms: 30 * 24 * 60 * 60 * 1000 },
} as const;
export type TimeRange = keyof typeof TIME_RANGES;

/** `all`, `domain:<domain>`, or `type:<exact event type>`. */
export type TypeFilter = string;
/** `all`, `person:<personId>`, or `kind:<actorType>`. */
export type ActorFilter = string;

export interface ActivityFilters {
  search: string;
  type: TypeFilter;
  actor: ActorFilter;
  time: TimeRange;
}

export const NO_FILTERS: ActivityFilters = {
  search: "",
  type: "all",
  actor: "all",
  time: "all",
};

export function domainOf(type: string): string {
  return type.split(".")[0] ?? type;
}

export function domainLabel(domain: string): string {
  return DOMAIN_LABEL[domain] ?? domain;
}

/** How many filters are narrowing the list — drives the badge on the Filters
 * button and whether the "no match" empty state offers a way out. A search of
 * only whitespace matches everything, so it doesn't count. */
export function activeFilterCount(filters: ActivityFilters): number {
  return (
    (filters.type === "all" ? 0 : 1) +
    (filters.actor === "all" ? 0 : 1) +
    (filters.time === "all" ? 0 : 1) +
    (filters.search.trim() ? 1 : 0)
  );
}

/**
 * `now` is passed in rather than read from `Date.now()` so the time-range cutoff
 * is one fixed instant for a whole pass, and so a test can pin it.
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

  if (filters.type.startsWith("domain:") && domainOf(entry.type) !== filters.type.slice(7)) {
    return false;
  }
  if (filters.type.startsWith("type:") && entry.type !== filters.type.slice(5)) return false;

  if (filters.actor.startsWith("person:")) {
    if (entry.actorType !== "person" || entry.actorId !== filters.actor.slice(7)) return false;
  }
  if (filters.actor.startsWith("kind:") && entry.actorType !== filters.actor.slice(5)) return false;

  // `occurredAt` (when it happened), not `recordedAt` (when we heard about it)
  // — "last 24 hours" is a question about the machine, not about ingestion.
  const window = TIME_RANGES[filters.time].ms;
  if (window !== null && new Date(entry.occurredAt).getTime() < now - window) return false;

  return true;
}

export function filterActivity(
  entries: AuditTimelineEntry[],
  filters: ActivityFilters,
  now: number = Date.now(),
): AuditTimelineEntry[] {
  return entries.filter((entry) => matchesActivityFilters(entry, filters, now));
}

export interface TypeGroup {
  domain: string;
  types: string[];
}

/**
 * The event picker's options, grouped by domain.
 *
 * Callers derive this from everything loaded, never from the filtered result —
 * options that vanish as you narrow leave you unable to widen again without
 * clearing.
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

export interface ActorOptions {
  persons: { id: string; label: string }[];
  kinds: string[];
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
      .map((id) => ({ id, label: people?.find((person) => person.id === id)?.email ?? id }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    kinds: Object.keys(ACTOR_KIND_LABEL).filter((kind) => kinds.has(kind)),
  };
}

/** Which dimension a facet count is being computed for, i.e. the one to ignore. */
export type FilterDimension = keyof ActivityFilters;

/**
 * Everything that passes every filter EXCEPT one.
 *
 * This is what a facet count is counted over. Counting a dimension's options
 * against its own current value would make every unselected option read 0, which
 * says nothing; counting them against the *other* filters answers the question
 * you actually have with the menu open — "if I pick this instead, what do I get".
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
  /** Matching "All events", i.e. no type constraint at all. */
  total: number;
  byDomain: Record<string, number>;
  byType: Record<string, number>;
}

export function deriveTypeFacets(
  entries: AuditTimelineEntry[],
  filters: ActivityFilters,
  now: number = Date.now(),
): TypeFacets {
  const scope = filterActivityExcept(entries, filters, "type", now);
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
  /** Matching "Anyone", i.e. no actor constraint at all. */
  total: number;
  byPerson: Record<string, number>;
  byKind: Record<string, number>;
}

export function deriveActorFacets(
  entries: AuditTimelineEntry[],
  filters: ActivityFilters,
  now: number = Date.now(),
): ActorFacets {
  const scope = filterActivityExcept(entries, filters, "actor", now);
  const byPerson: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  for (const item of scope) {
    if (item.actorType === "person") {
      if (item.actorId) byPerson[item.actorId] = (byPerson[item.actorId] ?? 0) + 1;
    } else {
      byKind[item.actorType] = (byKind[item.actorType] ?? 0) + 1;
    }
  }
  return { total: scope.length, byPerson, byKind };
}

/** Count for one time range, against every other filter — lets the When pills
 * show what each window holds before you commit to it. */
export function deriveTimeFacets(
  entries: AuditTimelineEntry[],
  filters: ActivityFilters,
  now: number = Date.now(),
): Record<TimeRange, number> {
  const scope = filterActivityExcept(entries, filters, "time", now);
  const counts = {} as Record<TimeRange, number>;
  for (const range of Object.keys(TIME_RANGES) as TimeRange[]) {
    const window = TIME_RANGES[range].ms;
    counts[range] =
      window === null
        ? scope.length
        : scope.filter((item) => new Date(item.occurredAt).getTime() >= now - window).length;
  }
  return counts;
}

/** The label for one dimension's current value, for the section header — so the
 * menu says what is set without making you scroll a list to find the tick. */
export function describeTypeFilter(value: TypeFilter): string | null {
  if (value === "all") return null;
  if (value.startsWith("domain:")) return `All ${domainLabel(value.slice(7)).toLowerCase()}`;
  return value.slice(5);
}

export function describeActorFilter(value: ActorFilter, options: ActorOptions): string | null {
  if (value === "all") return null;
  if (value.startsWith("kind:")) return ACTOR_KIND_LABEL[value.slice(5)] ?? value.slice(5);
  const id = value.slice(7);
  return options.persons.find((person) => person.id === id)?.label ?? id;
}
