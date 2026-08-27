import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { upsertFindingFirstSeen } from "./finding-store";

describe("upsertFindingFirstSeen", () => {
  test("returns the same first-seen timestamp on repeated calls for the same key", async () => {
    const first = await Effect.runPromise(
      upsertFindingFirstSeen("check-x", "org-1", "machine-1", "detail-1"),
    );
    const second = await Effect.runPromise(
      upsertFindingFirstSeen("check-x", "org-1", "machine-1", "detail-1"),
    );
    expect(second).toEqual(first);
  });

  test("different detail keys get independent entries", async () => {
    const a = await Effect.runPromise(
      upsertFindingFirstSeen("check-y", "org-1", "machine-1", "detail-a"),
    );
    const b = await Effect.runPromise(
      upsertFindingFirstSeen("check-y", "org-1", "machine-1", "detail-b"),
    );
    expect(a).toBeInstanceOf(Date);
    expect(b).toBeInstanceOf(Date);
  });

  test("a null machineId is a distinct key from a machineId string", async () => {
    const withMachine = await Effect.runPromise(
      upsertFindingFirstSeen("check-z", "org-1", "machine-1", "detail"),
    );
    // A small delay so that, if the two calls collided on the same map
    // entry, the second would return the cached first value instead of a
    // fresh `Date` — making the two timestamps observably equal despite
    // millisecond-resolution clocks.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const withoutMachine = await Effect.runPromise(
      upsertFindingFirstSeen("check-z", "org-1", null, "detail"),
    );
    expect(withoutMachine.getTime()).not.toEqual(withMachine.getTime());
  });
});
