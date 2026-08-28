import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { AttestationMethodTag } from "./AttestationMethod";
import { JoinTokenAttestationLive } from "./JoinTokenAttestation";

const run = <A, E>(effect: Effect.Effect<A, E, AttestationMethodTag>) =>
  Effect.runPromise(Effect.provide(effect, JoinTokenAttestationLive));

describe("JoinTokenAttestation", () => {
  test("issued credential round-trips through verifyCredential", async () => {
    const identity = await run(
      Effect.gen(function* () {
        const attestation = yield* AttestationMethodTag;
        const credential = yield* attestation.issueCredential({
          orgId: "org-1",
          machineId: "machine-1",
        });
        return yield* attestation.verifyCredential(credential);
      }),
    );

    expect(identity).toEqual({ orgId: "org-1", machineId: "machine-1" });
  });

  test("reports its method as join_token", async () => {
    const method = await run(Effect.map(AttestationMethodTag, (a) => a.method));
    expect(method).toBe("join_token");
  });

  // Explicit failure-path test (required by this unit's brief): attesting with an
  // invalid/garbage join token must be REJECTED with a specific typed error, never a
  // generic crash. The HTTP-layer + `agent.attestation_failed`-event half of this
  // requirement is covered by `../../http/handlers/agent-protocol.integration.test.ts`.
  test("rejects a garbage credential with a typed malformed_credential error, not a crash", async () => {
    const program = Effect.gen(function* () {
      const attestation = yield* AttestationMethodTag;
      return yield* attestation.verifyCredential("this-is-not-a-real-token");
    });

    const error = await Effect.runPromise(
      Effect.flip(Effect.provide(program, JoinTokenAttestationLive)),
    );
    expect(error._tag).toBe("AttestationError");
    expect(error.reason).toBe("malformed_credential");
    expect(error.claimedOrgId).toBeUndefined();
    expect(error.claimedMachineId).toBeUndefined();
  });

  test("rejects an empty string credential", async () => {
    const program = Effect.gen(function* () {
      const attestation = yield* AttestationMethodTag;
      return yield* attestation.verifyCredential("");
    });

    const error = await Effect.runPromise(
      Effect.flip(Effect.provide(program, JoinTokenAttestationLive)),
    );
    expect(error.reason).toBe("malformed_credential");
  });

  test("rejects a well-shaped credential with a tampered signature, attributing the claimed identity", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.provide(
          Effect.gen(function* () {
            const attestation = yield* AttestationMethodTag;
            const credential = yield* attestation.issueCredential({
              orgId: "org-1",
              machineId: "machine-1",
            });
            const tampered = `${credential.slice(0, -4)}AAAA`;
            return yield* attestation.verifyCredential(tampered);
          }),
          JoinTokenAttestationLive,
        ),
      ),
    );

    expect(error.reason).toBe("invalid_signature");
    expect(error.claimedOrgId).toBe("org-1");
    expect(error.claimedMachineId).toBe("machine-1");
  });

  test("rejects a credential signed under a different secret", async () => {
    const credential = await run(
      Effect.flatMap(AttestationMethodTag, (a) =>
        a.issueCredential({ orgId: "org-1", machineId: "machine-1" }),
      ),
    );

    const previous = process.env["JOIN_TOKEN_SECRET"];
    process.env["JOIN_TOKEN_SECRET"] = "a-different-secret";
    try {
      const error = await Effect.runPromise(
        Effect.flip(
          Effect.provide(
            Effect.flatMap(AttestationMethodTag, (a) => a.verifyCredential(credential)),
            JoinTokenAttestationLive,
          ),
        ),
      );
      expect(error.reason).toBe("invalid_signature");
    } finally {
      if (previous === undefined) delete process.env["JOIN_TOKEN_SECRET"];
      else process.env["JOIN_TOKEN_SECRET"] = previous;
    }
  });
});
