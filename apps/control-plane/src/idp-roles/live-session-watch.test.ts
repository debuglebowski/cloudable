import { describe, expect, it } from "bun:test";
import { Duration, Effect, Ref, TestClock, TestContext } from "effect";
import type { IdpRolesConfig } from "./config";
import {
  REVOCATION_POLL_MS,
  STANDING_READ_TIMEOUT_MS,
  type StandingRead,
  allowedUntil,
  isPastDeadline,
  watchLiveSession,
} from "./live-session-watch";
import type { PersonStanding } from "./standing";

const managed: IdpRolesConfig = {
  enabled: true,
  claim: "roles",
  mapping: { A: ["admin"] },
  intervalSec: 3600,
  fingerprint: "f",
};

/** TestClock starts at BASE. Evidence verified 3570s before: the deadline is BASE + 30s. */
const BASE = 1_800_000_000_000;
const VERIFIED = new Date(BASE - 3570_000);
const DEADLINE = BASE + 30_000;
const MINTED = BASE - 60_000;
const fresh = (over: Partial<PersonStanding> = {}): StandingRead => ({
  person: { active: true, credentialsRevokedAt: null, idpRolesVerifiedAt: VERIFIED, ...over },
  fence: "ok",
});

const run = <A>(
  body: (ctx: {
    standing: Ref.Ref<Effect.Effect<StandingRead, unknown>>;
    lapsed: Ref.Ref<number | null>;
    deadline: Ref.Ref<number>;
  }) => Effect.Effect<A>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(BASE);
      const standing = yield* Ref.make<Effect.Effect<StandingRead, unknown>>(
        Effect.succeed(fresh()),
      );
      const lapsed = yield* Ref.make<number | null>(null);
      const deadline = yield* Ref.make(allowedUntil(fresh(), MINTED, BASE, managed) ?? 0);
      yield* Effect.fork(
        watchLiveSession({
          idpRoles: managed,
          issuedAtMs: MINTED,
          readStanding: Effect.flatten(Ref.get(standing)),
          onLapse: Effect.flatMap(TestClock.currentTimeMillis, (now) => Ref.set(lapsed, now)),
          deadline,
        }),
      );
      return yield* body({ standing, lapsed, deadline });
    }).pipe(Effect.provide(TestContext.TestContext)),
  );

describe("watchLiveSession", () => {
  it("ends the session at the exact deadline, not a moment later", async () => {
    await run(({ lapsed, deadline }) =>
      Effect.gen(function* () {
        expect(yield* Ref.get(deadline)).toBe(DEADLINE);
        yield* TestClock.adjust(Duration.millis(29_999));
        expect(yield* Ref.get(lapsed)).toBeNull();
        expect(yield* isPastDeadline(deadline)).toBe(false);
        yield* TestClock.adjust(Duration.millis(1));
        expect(yield* Ref.get(lapsed)).toBe(DEADLINE);
        expect(yield* isPastDeadline(deadline)).toBe(true);
      }),
    );
  });

  it("does not read anything at the deadline: a hung database cannot extend it", async () => {
    await run(({ standing, lapsed }) =>
      Effect.gen(function* () {
        // Polls at +10s and +20s succeed; then the database hangs for good.
        yield* TestClock.adjust(Duration.millis(2 * REVOCATION_POLL_MS));
        yield* Ref.set(standing, Effect.never);
        yield* TestClock.adjust(Duration.millis(10_000));
        expect(yield* Ref.get(lapsed)).toBe(DEADLINE);
      }),
    );
  });

  it("a fresh SSO sign-in before the deadline moves it forward", async () => {
    await run(({ standing, lapsed, deadline }) =>
      Effect.gen(function* () {
        yield* Ref.set(
          standing,
          Effect.succeed(fresh({ idpRolesVerifiedAt: new Date(BASE + 5_000) })),
        );
        yield* TestClock.adjust(Duration.millis(REVOCATION_POLL_MS));
        expect(yield* Ref.get(deadline)).toBe(BASE + 3_605_000);
        yield* TestClock.adjust(Duration.millis(30_000));
        expect(yield* Ref.get(lapsed)).toBeNull();
      }),
    );
  });

  it("revocation ends it within one poll", async () => {
    await run(({ standing, lapsed }) =>
      Effect.gen(function* () {
        yield* Ref.set(
          standing,
          Effect.succeed(fresh({ credentialsRevokedAt: new Date(BASE + 1_000) })),
        );
        yield* TestClock.adjust(Duration.millis(REVOCATION_POLL_MS));
        expect(yield* Ref.get(lapsed)).toBe(BASE + REVOCATION_POLL_MS);
      }),
    );
  });

  it("a failed, hung or mismatched read fails closed", async () => {
    for (const failure of [
      Effect.fail("db down"),
      Effect.die("boom"),
      Effect.never,
      Effect.succeed<StandingRead>({ ...fresh(), fence: "mismatch" }),
      Effect.succeed<StandingRead>({ person: undefined, fence: "ok" }),
    ] as Array<Effect.Effect<StandingRead, unknown>>) {
      await run(({ standing, lapsed, deadline }) =>
        Effect.gen(function* () {
          yield* Ref.set(standing, failure);
          yield* TestClock.adjust(Duration.millis(REVOCATION_POLL_MS + STANDING_READ_TIMEOUT_MS));
          const at = yield* Ref.get(lapsed);
          expect(at).not.toBeNull();
          expect(at ?? Number.POSITIVE_INFINITY).toBeLessThan(DEADLINE);
          expect(yield* isPastDeadline(deadline)).toBe(true);
        }),
      );
    }
  });
});

describe("allowedUntil", () => {
  it("is the contract's deadline: the start of second floor(verifiedAt) + interval", () => {
    const read = fresh({ idpRolesVerifiedAt: new Date(BASE + 1_500) });
    expect(allowedUntil(read, BASE, BASE + 2_000, managed)).toBe(BASE + 3_601_000);
  });

  it("refuses a session minted before the person's credentials were revoked", () => {
    const read = fresh({
      idpRolesVerifiedAt: new Date(BASE + 20_000),
      credentialsRevokedAt: new Date(BASE + 10_000),
    });
    expect(allowedUntil(read, BASE + 5_000, BASE + 30_000, managed)).toBeNull();
    expect(allowedUntil(read, BASE + 15_000, BASE + 30_000, managed)).toBe(BASE + 3_620_000);
  });
});
