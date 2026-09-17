import { describe, expect, test } from "bun:test";

import type { AuditTimelineEntry } from "@/api/audit";
import type { DirectoryPerson } from "@/api/people-directory";

import {
  ANY_TIME,
  NO_FILTERS,
  TIME_PRESETS,
  activeFilterCount,
  deriveActorFacets,
  deriveActorOptions,
  deriveTimeFacets,
  deriveTypeFacets,
  deriveTypeGroups,
  describeActors,
  describeTimeFilter,
  describeTypes,
  filterActivity,
  filterActivityExcept,
  groupState,
  isSameTimeFilter,
  timeCutoff,
  toggleGroup,
  toggleSelection,
} from "./machine-activity-filters";

// A fixed "now" so the time cases don't drift with the clock.
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

  test("search matches the summary and the event type, case-insensitively", () => {
    expect(ids(filterActivity(ENTRIES, { ...NO_FILTERS, search: "TERMINAL" }, NOW))).toEqual(["c"]);
    expect(ids(filterActivity(ENTRIES, { ...NO_FILTERS, search: "snapshot." }, NOW))).toEqual([
      "d",
    ]);
  });

  test("whitespace-only search matches everything", () => {
    expect(ids(filterActivity(ENTRIES, { ...NO_FILTERS, search: "   " }, NOW))).toHaveLength(4);
  });

  test("filters compose", () => {
    expect(
      ids(
        filterActivity(
          ENTRIES,
          {
            search: "reported",
            types: ["machine.state_reported"],
            actors: ["kind:agent"],
            time: { amount: 24, unit: "hours" },
          },
          NOW,
        ),
      ),
    ).toEqual(["b"]);
  });
});

describe("multi-select types", () => {
  test("an empty list means every type", () => {
    expect(ids(filterActivity(ENTRIES, { ...NO_FILTERS, types: [] }, NOW))).toHaveLength(4);
  });

  test("one type keeps only that type", () => {
    expect(
      ids(filterActivity(ENTRIES, { ...NO_FILTERS, types: ["machine.started"] }, NOW)),
    ).toEqual(["a"]);
  });

  test("several types are OR'd, not AND'd", () => {
    expect(
      ids(
        filterActivity(
          ENTRIES,
          { ...NO_FILTERS, types: ["machine.started", "snapshot.created"] },
          NOW,
        ),
      ),
    ).toEqual(["a", "d"]);
  });
});

describe("multi-select actors", () => {
  test("an empty list means anyone", () => {
    expect(ids(filterActivity(ENTRIES, { ...NO_FILTERS, actors: [] }, NOW))).toHaveLength(4);
  });

  test("a person selector never matches a non-person sharing the id", () => {
    const systemSharingAnId = entry({ id: "e", actorType: "system", actorId: "person-1" });
    expect(
      ids(
        filterActivity(
          [...ENTRIES, systemSharingAnId],
          { ...NO_FILTERS, actors: ["person:person-1"] },
          NOW,
        ),
      ),
    ).toEqual(["a"]);
  });

  test("a person and a kind can be selected together", () => {
    expect(
      ids(
        filterActivity(ENTRIES, { ...NO_FILTERS, actors: ["person:person-2", "kind:system"] }, NOW),
      ),
    ).toEqual(["c", "d"]);
  });
});

describe("toggleSelection / toggleGroup / groupState", () => {
  test("toggling adds then removes, keeping selection order", () => {
    expect(toggleSelection([], "a")).toEqual(["a"]);
    expect(toggleSelection(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleSelection(["a", "b"], "a")).toEqual(["b"]);
  });

  test("a group ticks everything missing without duplicating", () => {
    expect(toggleGroup(["a"], ["a", "b"], true)).toEqual(["a", "b"]);
    expect(toggleGroup(["a", "b"], ["a", "b"], true)).toEqual(["a", "b"]);
  });

  test("unticking a group leaves selections outside it alone", () => {
    expect(toggleGroup(["a", "b", "z"], ["a", "b"], false)).toEqual(["z"]);
  });

  test("group state distinguishes none, some and all", () => {
    expect(groupState([], ["a", "b"])).toBe("none");
    expect(groupState(["a"], ["a", "b"])).toBe("some");
    expect(groupState(["a", "b"], ["a", "b"])).toBe("all");
  });
});

describe("time", () => {
  test("no amount means no cutoff", () => {
    expect(timeCutoff(ANY_TIME, NOW)).toBeNull();
    expect(timeCutoff({ amount: 0, unit: "days" }, NOW)).toBeNull();
    expect(timeCutoff({ amount: Number.NaN, unit: "days" }, NOW)).toBeNull();
    // A negative window would otherwise put the cutoff in the future and hide
    // everything, which reads as "no events" rather than as bad input.
    expect(timeCutoff({ amount: -5, unit: "days" }, NOW)).toBeNull();
  });

  test("fixed-length units multiply out", () => {
    expect(timeCutoff({ amount: 30, unit: "minutes" }, NOW)).toBe(NOW - 30 * 60_000);
    expect(timeCutoff({ amount: 6, unit: "hours" }, NOW)).toBe(NOW - 6 * 3_600_000);
    expect(timeCutoff({ amount: 2, unit: "weeks" }, NOW)).toBe(NOW - 14 * 86_400_000);
  });

  test("months walk the calendar rather than averaging 30 days", () => {
    // 2026-09-16 minus 3 months is 2026-06-16, which is 92 days back, not 90.
    const cutoff = timeCutoff({ amount: 3, unit: "months" }, NOW);
    expect(new Date(cutoff ?? 0).toISOString()).toBe("2026-06-16T12:00:00.000Z");
    expect(cutoff).not.toBe(NOW - 90 * 86_400_000);
  });

  test("an arbitrary window filters on occurredAt", () => {
    expect(
      ids(filterActivity(ENTRIES, { ...NO_FILTERS, time: { amount: 90, unit: "minutes" } }, NOW)),
    ).toEqual(["a"]);
    expect(
      ids(filterActivity(ENTRIES, { ...NO_FILTERS, time: { amount: 2, unit: "weeks" } }, NOW)),
    ).toEqual(["a", "b", "c", "d"]);
  });

  test("a recent event recorded late still counts as recent", () => {
    // occurredAt is what the filter reads; recordedAt lags when an agent has
    // been offline, and "last 24 hours" is a question about the machine.
    const lateArrival = entry({ id: "late", occurredAt: hoursAgo(2), recordedAt: hoursAgo(0) });
    const stale = entry({ id: "stale", occurredAt: hoursAgo(72), recordedAt: hoursAgo(0) });
    expect(
      ids(
        filterActivity(
          [lateArrival, stale],
          { ...NO_FILTERS, time: { amount: 24, unit: "hours" } },
          NOW,
        ),
      ),
    ).toEqual(["late"]);
  });

  test("two any-times are equal whatever unit each is parked on", () => {
    expect(isSameTimeFilter({ amount: null, unit: "days" }, { amount: null, unit: "months" })).toBe(
      true,
    );
    expect(isSameTimeFilter({ amount: 7, unit: "days" }, { amount: 7, unit: "weeks" })).toBe(false);
    expect(isSameTimeFilter({ amount: 7, unit: "days" }, { amount: 7, unit: "days" })).toBe(true);
  });

  test("a window reads back as its preset name when it matches one", () => {
    expect(describeTimeFilter(ANY_TIME)).toBeNull();
    expect(describeTimeFilter({ amount: 24, unit: "hours" })).toBe("24 hours");
    expect(describeTimeFilter({ amount: 7, unit: "days" })).toBe("7 days");
  });

  test("an arbitrary window reads back as itself, singular when it is one", () => {
    expect(describeTimeFilter({ amount: 90, unit: "minutes" })).toBe("Last 90 minutes");
    expect(describeTimeFilter({ amount: 1, unit: "months" })).toBe("Last 1 month");
    expect(describeTimeFilter({ amount: 3, unit: "months" })).toBe("Last 3 months");
  });
});

describe("activeFilterCount", () => {
  test("counts nothing when untouched", () => {
    expect(activeFilterCount(NO_FILTERS)).toBe(0);
  });

  test("a whitespace-only search is not an active filter", () => {
    expect(activeFilterCount({ ...NO_FILTERS, search: "  " })).toBe(0);
  });

  test("a dimension counts once however many values it holds", () => {
    // The badge answers "how much is narrowed", not "how many boxes are ticked".
    expect(activeFilterCount({ ...NO_FILTERS, types: ["a"] })).toBe(1);
    expect(activeFilterCount({ ...NO_FILTERS, types: ["a", "b", "c"] })).toBe(1);
  });

  test("counts each narrowed dimension", () => {
    expect(
      activeFilterCount({
        search: "x",
        types: ["machine.started"],
        actors: ["kind:agent"],
        time: { amount: 7, unit: "days" },
      }),
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
    expect(deriveActorOptions(ENTRIES, people).persons).toEqual([
      { value: "person:person-2", label: "jordan.blake@acme.com" },
      // Unresolvable ids fall back to the raw id rather than disappearing —
      // an actor you can't name is still an actor you can filter by.
      { value: "person:person-1", label: "person-1" },
    ]);
  });

  test("lists only the non-person kinds actually present", () => {
    expect(deriveActorOptions(ENTRIES, people).kinds).toEqual([
      { value: "kind:system", label: "System" },
      { value: "kind:agent", label: "Agent" },
    ]);
    expect(deriveActorOptions([onlyMachineStarted], people).kinds).toEqual([]);
  });
});

describe("facet counts", () => {
  test("filterActivityExcept ignores exactly one dimension", () => {
    const filters = {
      ...NO_FILTERS,
      types: ["machine.started"],
      time: { amount: 24, unit: "hours" as const },
    };
    // types ignored, time still applied.
    expect(ids(filterActivityExcept(ENTRIES, filters, "types", NOW))).toEqual(["a", "b"]);
    // time ignored, types still applied.
    expect(ids(filterActivityExcept(ENTRIES, filters, "time", NOW))).toEqual(["a"]);
  });

  test("type facets count against the OTHER filters, not their own", () => {
    // With the actor pinned to the agent, ticking machine.started would yield
    // nothing — the menu should say 0 up front rather than after the click.
    const facets = deriveTypeFacets(ENTRIES, { ...NO_FILTERS, actors: ["kind:agent"] }, NOW);
    expect(facets.total).toBe(1);
    expect(facets.byType["machine.state_reported"]).toBe(1);
    expect(facets.byType["machine.started"]).toBeUndefined();
    expect(facets.byDomain.machine).toBe(1);
  });

  test("a type facet is unaffected by the types already ticked", () => {
    // Otherwise every unticked option would read 0 and the counts would be useless.
    const facets = deriveTypeFacets(ENTRIES, { ...NO_FILTERS, types: ["machine.started"] }, NOW);
    expect(facets.total).toBe(4);
    expect(facets.byDomain).toEqual({ machine: 2, access: 1, snapshot: 1 });
  });

  test("actor facets are keyed by the selector the filter stores", () => {
    const facets = deriveActorFacets(ENTRIES, NO_FILTERS, NOW);
    expect(facets.total).toBe(4);
    expect(facets.byActor).toEqual({
      "person:person-1": 1,
      "person:person-2": 1,
      "kind:agent": 1,
      "kind:system": 1,
    });
  });

  test("actor facets ignore the actor filter but honour the rest", () => {
    const facets = deriveActorFacets(
      ENTRIES,
      { ...NO_FILTERS, actors: ["kind:agent"], time: { amount: 24, unit: "hours" } },
      NOW,
    );
    // Within 24h: a (person-1) and b (agent). The actor filter itself is ignored.
    expect(facets.total).toBe(2);
    expect(facets.byActor).toEqual({ "person:person-1": 1, "kind:agent": 1 });
  });

  test("time facets count each preset against the other filters", () => {
    const presets = TIME_PRESETS.map((preset) => preset.value);
    expect(deriveTimeFacets(ENTRIES, NO_FILTERS, presets, NOW)).toEqual([4, 2, 3, 4]);
    // With the type pinned to machine events, only a and b remain, both in 24h.
    expect(
      deriveTimeFacets(
        ENTRIES,
        { ...NO_FILTERS, types: ["machine.started", "machine.state_reported"] },
        presets,
        NOW,
      ),
    ).toEqual([2, 2, 2, 2]);
  });
});

describe("read-back labels", () => {
  test("types read back as themselves, then as a count", () => {
    expect(describeTypes([])).toBe("All events");
    expect(describeTypes(["machine.started"])).toBe("machine.started");
    expect(describeTypes(["machine.started", "snapshot.created"])).toBe("2 event types");
  });

  test("actors resolve to a label, then to a count", () => {
    const options = deriveActorOptions(ENTRIES, [
      { id: "person-2", email: "jordan.blake@acme.com", role: "member", active: true },
    ]);
    expect(describeActors([], options)).toBe("Anyone");
    expect(describeActors(["person:person-2"], options)).toBe("jordan.blake@acme.com");
    expect(describeActors(["kind:system"], options)).toBe("System");
    expect(describeActors(["person:person-2", "kind:system"], options)).toBe("2 actors");
  });

  test("an actor no longer in the loaded set still reads back as its id", () => {
    const options = deriveActorOptions(ENTRIES, undefined);
    expect(describeActors(["person:ghost"], options)).toBe("ghost");
  });
});
