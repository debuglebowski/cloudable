import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { AgentSessionToken } from "./AgentSessionToken";

const run = <A, E>(effect: Effect.Effect<A, E, AgentSessionToken>) =>
  Effect.runPromise(Effect.provide(effect, AgentSessionToken.Default));

describe("AgentSessionToken", () => {
  test("a minted token verifies back to the same identity", async () => {
    const identity = await run(
      Effect.gen(function* () {
        const sessions = yield* AgentSessionToken;
        const { token } = sessions.mint({ orgId: "org-1", machineId: "machine-1" });
        return yield* sessions.verify(token);
      }),
    );
    expect(identity).toEqual({ orgId: "org-1", machineId: "machine-1" });
  });

  test("mint sets expiresAt in the future by the configured TTL", async () => {
    const before = Date.now();
    const expiresAt = await run(
      Effect.map(
        AgentSessionToken,
        (sessions) => sessions.mint({ orgId: "org-1", machineId: "machine-1" }).expiresAt,
      ),
    );
    expect(expiresAt.getTime()).toBeGreaterThan(before);
  });

  test("rejects a malformed token", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.provide(
          Effect.flatMap(AgentSessionToken, (sessions) => sessions.verify("garbage")),
          AgentSessionToken.Default,
        ),
      ),
    );
    expect(error.reason).toBe("malformed_token");
  });

  test("rejects a tampered signature", async () => {
    const token = await run(
      Effect.map(
        AgentSessionToken,
        (sessions) => sessions.mint({ orgId: "org-1", machineId: "machine-1" }).token,
      ),
    );
    const tampered = `${token.slice(0, -4)}AAAA`;

    const error = await Effect.runPromise(
      Effect.flip(
        Effect.provide(
          Effect.flatMap(AgentSessionToken, (sessions) => sessions.verify(tampered)),
          AgentSessionToken.Default,
        ),
      ),
    );
    expect(error.reason).toBe("invalid_signature");
  });

  test("rejects an expired token", async () => {
    const previous = process.env.AGENT_SESSION_TTL_SECONDS;
    process.env.AGENT_SESSION_TTL_SECONDS = "-1"; // mint a token already in the past
    try {
      const error = await Effect.runPromise(
        Effect.flip(
          Effect.provide(
            Effect.gen(function* () {
              const sessions = yield* AgentSessionToken;
              const { token } = sessions.mint({ orgId: "org-1", machineId: "machine-1" });
              return yield* sessions.verify(token);
            }),
            AgentSessionToken.Default,
          ),
        ),
      );
      expect(error.reason).toBe("expired");
    } finally {
      if (previous === undefined) process.env.AGENT_SESSION_TTL_SECONDS = undefined;
      else process.env.AGENT_SESSION_TTL_SECONDS = previous;
    }
  });
});
