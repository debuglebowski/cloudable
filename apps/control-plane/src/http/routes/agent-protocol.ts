import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";

/**
 * The control agent protocol: attest, poll, report — one
 * `HttpApiGroup` mounted at `/api/v1/agent`. Handler implementations live
 * in `../handlers/agent-protocol.ts`, kept separate so this file (imported
 * by both `../api.ts` and the handlers file) never has to import `Api`
 * itself and create an import cycle — mirroring the existing `health`
 * group/handler split (`../api.ts` defines `HealthGroup` inline;
 * `../handlers/health.ts` builds against `Api`).
 *
 * `wake` (the fourth operation, CP → agent) isn't here: `HttpApiEndpoint`
 * only models HTTP verbs, not a websocket upgrade. See `agent-wake.ts`.
 */

/** 401: the credential presented to `/attest` didn't verify. */
export class AttestRejected extends Schema.TaggedError<AttestRejected>()("AttestRejected", {
  reason: Schema.String,
}) {}

/** 401: the bearer session presented to `/poll` or `/report` is missing, malformed, or expired. */
export class AgentUnauthorized extends Schema.TaggedError<AgentUnauthorized>()(
  "AgentUnauthorized",
  {
    reason: Schema.String,
  },
) {}

const AttestPayload = Schema.Struct({
  method: Schema.Literal("join_token", "managed_identity"),
  credential: Schema.String,
});

const AttestSuccess = Schema.Struct({
  bearerToken: Schema.String,
  expiresAt: Schema.String,
  orgId: Schema.String,
  machineId: Schema.String,
});

/** One package operation handed to the agent to perform. */
const PendingPackageAction = Schema.Struct({
  id: Schema.String,
  op: Schema.Literal("install", "uninstall"),
  packageName: Schema.String,
  versionPin: Schema.NullOr(Schema.String),
});

/** 200 body for `GET /poll` — a 304 (unchanged) has no body. See `docs/agents.md`. */
const DesiredState = Schema.Struct({
  version: Schema.String,
  // What this machine is ALLOWED to have, not an install list — the agent
  // acts on `pendingActions`, never on this.
  packages: Schema.Array(Schema.String),
  settings: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  pendingActions: Schema.Array(PendingPackageAction),
});

/** Mirrors `ConfigState` in `packages/contracts/src/domains/agent-protocol.ts`. */
const ConfigState = Schema.Struct({
  runningAccessMethods: Schema.Array(Schema.String),
});

/** What became of one action the agent collected. */
const PackageActionResult = Schema.Struct({
  id: Schema.String,
  outcome: Schema.Literal("succeeded", "failed"),
  detail: Schema.optional(Schema.String),
  installedVersion: Schema.optional(Schema.String),
});

const ReportPayload = Schema.Struct({
  agentVersion: Schema.String,
  observedAt: Schema.String,
  installedPackages: Schema.Array(Schema.String),
  // Declared packages only — see `AgentReportRequest`.
  declaredPackageVersions: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String }),
  ),
  openPorts: Schema.Array(Schema.Number),
  configState: ConfigState,
  // The machine's own measurement of its filesystems. Absent means the agent could
  // not measure them, which must not be recorded as a measurement of zero — see
  // `AgentReportRequest`. Each half is optional independently: a machine can have a
  // readable root and an unmounted persistent volume.
  volumeUsage: Schema.optional(
    Schema.Struct({
      persistent: Schema.optional(
        Schema.Struct({ usedBytes: Schema.Number, totalBytes: Schema.Number }),
      ),
      root: Schema.optional(Schema.Struct({ usedBytes: Schema.Number, totalBytes: Schema.Number })),
    }),
  ),
  actionResults: Schema.optional(Schema.Array(PackageActionResult)),
});

const ReportSuccess = Schema.Struct({ acknowledged: Schema.Literal(true) });

export const AgentProtocolGroup = HttpApiGroup.make("agent-protocol")
  .add(
    HttpApiEndpoint.post("attest", "/api/v1/agent/attest")
      .setPayload(AttestPayload)
      .addSuccess(AttestSuccess)
      .addError(AttestRejected, { status: 401 }),
  )
  .add(
    HttpApiEndpoint.get("poll", "/api/v1/agent/poll")
      .addSuccess(DesiredState)
      .addError(AgentUnauthorized, { status: 401 }),
  )
  .add(
    HttpApiEndpoint.post("report", "/api/v1/agent/report")
      .setPayload(ReportPayload)
      .addSuccess(ReportSuccess)
      .addError(AgentUnauthorized, { status: 401 }),
  );
