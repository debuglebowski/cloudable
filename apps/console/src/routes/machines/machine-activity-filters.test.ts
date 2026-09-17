import { describe, expect, test } from "bun:test";

import type { AuditTimelineEntry } from "@/api/audit";
import type { DirectoryPerson } from "@/api/people-directory";

import {
  NO_FILTERS,
  activeFilterCount,
  deriveActorFacets,
  deriveActorOptions,
  deriveTimeFacets,
  deriveTypeFacets,
  deriveTypeGroups,
  describeActorFilter,
  describeTypeFilter,
  filterActivity,
  filterActivityExcept,
} from "./machine-activity-filters";

// A fixed "now" so the time-range cases don't drift with the clock.
const NOW = new Date("2026-09-16T12:00:00.000Z").getTime();
const hoursAgo = (h: number) => new Date(NOW - h * 60 * 60 * 1000).toISOString();

function entry(over: Partial<AuditTimelineEntry> & { id: string }): AuditTimelineEntry {
  return {
    type: "machine.started",
    occurredAt: hoursAgo(1),
    recordedAt: hoursAgo(1),
    actorType: "person",
    actorId: "person-1",
    machineId: "machine-1",
    summary: "Machine started.",
    ...over,
  };
}

const ENTRIES: AuditTimelineEntry[] = [
  entry({ id: "a", type: "machine.started", summary: "Machine started.", occurredAt: hoursAgo(1) }),
  entry({
    id: "b",
    type: "machine.state_reported",
    summary: "Agent reported state.",
    actorType: "agent",
    actorId: "agent-1",
    occurredAt: hoursAgo(5),
  }),
  entry({
    id: "c",
    type: "access.session_started",
    summary: "Jordan opened a web terminal.",
    actorId: "person-2",
    occurredAt: hoursAgo(48),
  }),
  entry({
    id: "d",
    type: "snapshot.created",
    summary: "Pre-upgrade snapshot captured.",
    actorType: "system",
    actorId: "system",
    occurredAt: hoursAgo(24 * 10),
  }),
];

const ids = (entries: AuditTimelineEntry[]) => entries.map((e) => e.id);

/** A standalone copy of one fixture event, so a single-entry case doesn't need
 * to index into ENTRIES (and assert the index exists). */
const onlyMachineStarted = entry({ id: "a", type: "machine.started" });

describe("filterActivity", () => {
  test("no filters keeps every event, in order", () => {
    expect(ids(filterActivity(ENTRIES, NO_FILTERS, NOW))).toEqual(["a", "b", "c", "d"]);
  });

  test("a domain filter keeps the whole domain", () => {
    expect(ids(filterActivity(ENTRIES, { ...NO_FILTERS, type: "domain:machine" }, NOW))).toEqual([
      "a",
      "b",
    ]);
  });

  test("an exact type filter keeps only that type", () => {
    expect(
      ids(filterActivity(ENTRIES, { ...NO_FILTERS, type: "type:machine.started" }, NOW)),
    ).toEqual(["a"]);
  });

  test("search matches the summary and the event type, case-insensitively", () => {
    expect(ids(filterActivity(ENTRIES, { ...NO_FILTERS, search: "TERMINAL" }, NOW))).toEqual(["c"]);
    // The type is searchable too — typing a catalogue name is the fastest way
    // to a specific event, and only the summary was searchable at first.
    expect(ids(filterActivity(ENTRIES, { ...NO_FILTERS, search: "snapshot." }, NOW))).toEqual([
      "d",
    ]);
  });

  test("whitespace-only search matches everything", () => {
    expect(ids(filterActivity(ENTRIES, { ...NO_FILTERS, search: "   " }, NOW))).toHaveLength(4);
  });

  test("a person actor filter matches that person only, never a same-id non-person", () => {
    expect(ids(filterActivity(ENTRIES, { ...NO_FILTERS, actor: "person:person-1" }, NOW))).toEqual([
      "a",
    ]);
    const systemSharingAnId = entry({ id: "e", actorType: "system", actorId: "person-1" });
    expect(
      ids(
        filterActivity(
          [...ENTRIES, systemSharingAnId],
          { ...NO_FILTERS, actor: "person:person-1" },
          NOW,
        ),
      ),
    ).toEqual(["a"]);
  });

  test("a kind actor filter matches non-person actors", () => {
    expect(ids(filterActivity(ENTRIES, { ...NO_FILTERS, actor: "kind:agent" }, NOW))).toEqual([
      "b",
    ]);
    expect(ids(filterActivity(ENTRIES, { ...NO_FILTERS, actor: "kind:system" }, NOW))).toEqual([
      "d",
    ]);
  });

  test("time range cuts on occurredAt", () => {
    expect(ids(filterActivity(ENTRIES, { ...NO_FILTERS, time: "24h" }, NOW))).toEqual(["a", "b"]);
    expect(ids(filterActivity(ENTRIES, { ...NO_FILTERS, time: "7d" }, NOW))).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(ids(filterActivity(ENTRIES, { ...NO_FILTERS, time: "30d" }, NOW))).toHaveLength(4);
  });

  test("a recent event recorded late still counts as recent", () => {
    // occurredAt is what the filter reads; recordedAt lags when an agent has
    // been offline, and "last 24 hours" is a question about the machine.
    const lateArrival = entry({ id: "late", occurredAt: hoursAgo(2), recordedAt: hoursAgo(0) });
    const stale = entry({ id: "stale", occurredAt: hoursAgo(72), recordedAt: hoursAgo(0) });
    expect(ids(filterActivity([lateArrival, stale], { ...NO_FILTERS, time: "24h" }, NOW))).toEqual([
      "late",
    ]);
  });

  test("filters compose", () => {
    expect(
      ids(
        filterActivity(
          ENTRIES,
          { search: "reported", type: "domain:machine", actor: "kind:agent", time: "24h" },
          NOW,
        ),
      ),
    ).toEqual(["b"]);
  });
});

describe("activeFilterCount", () => {
  test("counts nothing when untouched", () => {
    expect(activeFilterCount(NO_FILTERS)).toBe(0);
  });

  test("a whitespace-only search is not an active filter", () => {
    expect(activeFilterCount({ ...NO_FILTERS, search: "  " })).toBe(0);
  });

  test("counts each narrowed dimension once", () => {
    expect(
      activeFilterCount({ search: "x", type: "domain:machine", actor: "kind:agent", time: "7d" }),
    ).toBe(4);
  });
});

describe("deriveTypeGroups", () => {
  test("groups by domain, machine first, types sorted and deduplicated", () => {
    expect(deriveTypeGroups([...ENTRIES, entry({ id: "dup", type: "machine.started" })])).toEqual([
      { domain: "machine", types: ["machine.started", "machine.state_reported"] },
      { domain: "access", types: ["access.session_started"] },
      { domain: "snapshot", types: ["snapshot.created"] },
    ]);
  });

  test("an unknown domain sorts last rather than first", () => {
    const groups = deriveTypeGroups([entry({ id: "x", type: "future.thing" }), onlyMachineStarted]);
    expect(groups.map((g) => g.domain)).toEqual(["machine", "future"]);
  });
});

describe("deriveActorOptions", () => {
  const people: DirectoryPerson[] = [
    { id: "person-2", email: "jordan.blake@acme.com", role: "member", active: true },
  ];

  test("resolves person actors to emails and sorts by label", () => {
    const options = deriveActorOptions(ENTRIES, people);
    expect(options.persons).toEqual([
      { id: "person-2", label: "jordan.blake@acme.com" },
      // Unresolvable ids fall back to the raw id rather than disappearing —
      // an actor you can't name is still an actor you can filter by.
      { id: "person-1", label: "person-1" },
    ]);
  });

  test("lists only the non-person kinds actually present", () => {
    expect(deriveActorOptions(ENTRIES, people).kinds).toEqual(["system", "agent"]);
    expect(deriveActorOptions([onlyMachineStarted], people).kinds).toEqual([]);
  });
});

describe("facet counts", () => {
  test("filterActivityExcept ignores exactly one dimension", () => {
    const filters = { ...NO_FILTERS, type: "domain:machine", time: "24h" as const };
    // type ignored, time still applied: a and b are inside 24h, c and d are not.
    expect(ids(filterActivityExcept(ENTRIES, filters, "type", NOW))).toEqual(["a", "b"]);
    // time ignored, type still applied.
    expect(ids(filterActivityExcept(ENTRIES, filters, "time", NOW))).toEqual(["a", "b"]);
  });

  test("type facets count against the OTHER filters, not their own", () => {
    // The point of a facet count: with actor pinned to the agent, picking
    // machine.started would yield nothing, and the menu should say 0 up front
    // rather than after the click.
    const facets = deriveTypeFacets(ENTRIES, { ...NO_FILTERS, actor: "kind:agent" }, NOW);
    expect(facets.total).toBe(1);
    expect(facets.byType["machine.state_reported"]).toBe(1);
    expect(facets.byType["machine.started"]).toBeUndefined();
    expect(facets.byDomain.machine).toBe(1);
  });

  test("an unfiltered type facet counts everything, grouped", () => {
    const facets = deriveTypeFacets(ENTRIES, NO_FILTERS, NOW);
    expect(facets.total).toBe(4);
    expect(facets.byDomain).toEqual({ machine: 2, access: 1, snapshot: 1 });
  });

  test("actor facets split people from non-person kinds", () => {
    const facets = deriveActorFacets(ENTRIES, NO_FILTERS, NOW);
    expect(facets.total).toBe(4);
    expect(facets.byPerson).toEqual({ "person-1": 1, "person-2": 1 });
    expect(facets.byKind).toEqual({ agent: 1, system: 1 });
  });

  test("actor facets ignore the actor filter but honour the rest", () => {
    const facets = deriveActorFacets(
      ENTRIES,
      { ...NO_FILTERS, actor: "kind:agent", time: "24h" },
      NOW,
    );
    // Within 24h: a (person-1) and b (agent). The actor filter itself is ignored.
    expect(facets.total).toBe(2);
    expect(facets.byPerson).toEqual({ "person-1": 1 });
    expect(facets.byKind).toEqual({ agent: 1 });
  });

  test("time facets count each window against the other filters", () => {
    expect(deriveTimeFacets(ENTRIES, NO_FILTERS, NOW)).toEqual({
      all: 4,
      "24h": 2,
      "7d": 3,
      "30d": 4,
    });
    // With the domain pinned to machine, only a and b remain, both inside 24h.
    expect(deriveTimeFacets(ENTRIES, { ...NO_FILTERS, type: "domain:machine" }, NOW)).toEqual({
      all: 2,
      "24h": 2,
      "7d": 2,
      "30d": 2,
    });
  });
});

describe("filter descriptions", () => {
  test("describeTypeFilter reads back what is set", () => {
    expect(describeTypeFilter("all")).toBeNull();
    expect(describeTypeFilter("domain:machine")).toBe("All machine");
    expect(describeTypeFilter("type:machine.started")).toBe("machine.started");
  });

  test("describeActorFilter resolves a person to their email", () => {
    const options = deriveActorOptions(ENTRIES, [
      { id: "person-2", email: "jordan.blake@acme.com", role: "member", active: true },
    ]);
    expect(describeActorFilter("all", options)).toBeNull();
    expect(describeActorFilter("person:person-2", options)).toBe("jordan.blake@acme.com");
    expect(describeActorFilter("kind:system", options)).toBe("System");
    // An actor no longer in the loaded set still reads back as its raw id
    // rather than as an empty header.
    expect(describeActorFilter("person:ghost", options)).toBe("ghost");
  });
});
