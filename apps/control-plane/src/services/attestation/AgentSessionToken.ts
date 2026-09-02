// ---------------------------------------------------------------------------
// Short-lived bearer session minted by `POST /attest` and required on every
// subsequent `/poll` and `/report` call. Deliberately separate
// from `AttestationMethod`: *which credential method proved the machine's
// identity* is a pluggable concern (join token today, managed identity
// later), but *how long the resulting session lasts and how it's carried
// on the wire* is not, and only ever needs one implementation — hence
// `Effect.Service`, not a `Context.Tag` port.
//
// Same self-contained-HMAC-string approach as `JoinTokenAttestation.ts` —
// see that file's comment for the tradeoff (no server-side revocation
// before expiry; a short TTL is the mitigation).
// ---------------------------------------------------------------------------
import * as crypto from "node:crypto";
import { Data, Effect } from "effect";
import type { MachineIdentity } from "./AttestationMethod";

export class AgentSessionError extends Data.TaggedError("AgentSessionError")<{
  reason: "malformed_token" | "invalid_signature" | "expired";
}> {}

const PURPOSE = "as";
const DEFAULT_TTL_SECONDS = 900; // 15 min — comfortably longer than the ~30s poll interval

const secret = (): string => process.env.AGENT_SESSION_SECRET ?? "dev-only-change-me";
const ttlSeconds = (): number =>
  Number(process.env.AGENT_SESSION_TTL_SECONDS ?? DEFAULT_TTL_SECONDS);

const sign = (data: string): string =>
  crypto.createHmac("sha256", secret()).update(data).digest("base64url");

interface SessionPayload {
  readonly purpose: typeof PURPOSE;
  readonly orgId: string;
  readonly machineId: string;
  readonly exp: number; // epoch ms
}

const isSessionPayload = (value: unknown): value is SessionPayload => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.purpose === PURPOSE &&
    typeof record.orgId === "string" &&
    typeof record.machineId === "string" &&
    typeof record.exp === "number"
  );
};

export interface MintedSession {
  readonly token: string;
  readonly expiresAt: Date;
}

export class AgentSessionToken extends Effect.Service<AgentSessionToken>()("AgentSessionToken", {
  effect: Effect.gen(function* () {
    const mint = (identity: MachineIdentity): MintedSession => {
      const exp = Date.now() + ttlSeconds() * 1000;
      const payload: SessionPayload = {
        purpose: PURPOSE,
        orgId: identity.orgId,
        machineId: identity.machineId,
        exp,
      };
      const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
      return {
        token: `${PURPOSE}.${body}.${sign(`${PURPOSE}.${body}`)}`,
        expiresAt: new Date(exp),
      };
    };

    const verify = (token: string): Effect.Effect<MachineIdentity, AgentSessionError> =>
      Effect.gen(function* () {
        const parts = token.split(".");
        if (parts.length !== 3 || parts[0] !== PURPOSE) {
          return yield* Effect.fail(new AgentSessionError({ reason: "malformed_token" }));
        }
        const [purpose, body, signature] = parts as [string, string, string];

        const expected = Buffer.from(sign(`${purpose}.${body}`));
        const provided = Buffer.from(signature);
        const signatureValid =
          expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
        if (!signatureValid) {
          return yield* Effect.fail(new AgentSessionError({ reason: "invalid_signature" }));
        }

        const decoded: unknown = yield* Effect.try({
          try: () => JSON.parse(Buffer.from(body, "base64url").toString("utf8")),
          catch: () => new AgentSessionError({ reason: "malformed_token" }),
        });
        if (!isSessionPayload(decoded)) {
          return yield* Effect.fail(new AgentSessionError({ reason: "malformed_token" }));
        }
        if (decoded.exp < Date.now()) {
          return yield* Effect.fail(new AgentSessionError({ reason: "expired" }));
        }
        return { orgId: decoded.orgId, machineId: decoded.machineId };
      });

    return { mint, verify } as const;
  }),
}) {}
