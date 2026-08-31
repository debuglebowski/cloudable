import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { Db } from "../db/layer";
import type { ComplianceCheck } from "../domain/compliance/types";
import { evaluateAllChecks } from "./evaluate-all";

// `appliesTo`/`evaluate` on these fake checks never actually touch `Db` — this is testing
// `evaluateAllChecks`'s own gating logic, decoupled from any real check's DB queries — so a
// dummy `Db` value (never dereferenced) is enough; no real Postgres needed for this file.
const fakeDb = Layer.succeed(Db, {} as never);

function fakeCheck(overrides: Partial<ComplianceCheck> & { id: string }): ComplianceCheck {
  return {
    label: overrides.id,
    controlRefs: [],
    severity: "medium",
    appliesTo: () => Effect.succeed(true),
    evaluate: () => Effect.succeed([]),
    ...overrides,
  };
}

const run = (checks: readonly ComplianceCheck[]) =>
  Effect.runPromise(Effect.provide(evaluateAllChecks("org-1", checks), fakeDb));

describe("evaluateAllChecks: applicability gating (spec §19)", () => {
  test("a check whose appliesTo resolves false is reported not_applicable, and evaluate is never called", async () => {
    let evaluateCalled = false;
    const check = fakeCheck({
      id: "gated-off",
      appliesTo: () => Effect.succeed(false),
      evaluate: () => {
        evaluateCalled = true;
        return Effect.succeed([]);
      },
    });

    const [result] = await run([check]);

    expect(result?.status).toBe("not_applicable");
    expect(result?.findings).toEqual([]);
    expect(evaluateCalled).toBe(false);
  });

  test("a check whose appliesTo resolves true is actually evaluated, and reports pass/fail from its real findings", async () => {
    const passingCheck = fakeCheck({ id: "clean", evaluate: () => Effect.succeed([]) });
    const failingCheck = fakeCheck({
      id: "dirty",
      evaluate: () =>
        Effect.succeed([
          {
            checkId: "dirty",
            orgId: "org-1",
            machineId: null,
            firstSeenAt: new Date(),
            detail: {},
          },
        ]),
    });

    const [pass, fail] = await run([passingCheck, failingCheck]);

    expect(pass?.status).toBe("pass");
    expect(fail?.status).toBe("fail");
    expect(fail?.findings).toHaveLength(1);
  });

  test("mixed applicability: each check's own appliesTo is independent of the others", async () => {
    const results = await run([
      fakeCheck({
        id: "a",
        appliesTo: () => Effect.succeed(true),
        evaluate: () => Effect.succeed([]),
      }),
      fakeCheck({ id: "b", appliesTo: () => Effect.succeed(false) }),
      fakeCheck({
        id: "c",
        appliesTo: () => Effect.succeed(true),
        evaluate: () => Effect.succeed([]),
      }),
    ]);

    expect(results.map((r) => r.status)).toEqual(["pass", "not_applicable", "pass"]);
  });
});
