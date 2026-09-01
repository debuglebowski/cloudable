import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";
import { CurrentUserAuthentication } from "../middleware/auth";

/**
 * `POST /api/v1/machines/:machineId/upgrade` — triggers the transactional
 * upgrade flow (CLAUDE.md unit 18). See
 * `apps/control-plane/src/domain/upgrade/UpgradeService.ts` for the
 * snapshot → apply → verify → rollback sequence this endpoint drives.
 */
export const UpgradeRequestPayload = Schema.Struct({
  targetImage: Schema.String,
});

export const UpgradeResponse = Schema.Struct({
  outcome: Schema.Literal("success", "rolled_back", "aborted", "rollback_failed"),
  machineId: Schema.String,
  attemptId: Schema.String,
  previousImage: Schema.String,
  currentImage: Schema.String,
  targetImage: Schema.String,
  snapshotId: Schema.NullOr(Schema.String),
  restoredSnapshotId: Schema.optional(Schema.String),
  nextEligibleAt: Schema.String,
  // Deep-link to the drift view on any non-"success" outcome — see
  // `driftViewUrl` in `domain/upgrade/types.ts`. Console units should honor
  // this exact `/machines/:id#drift` shape when the drift view lands.
  driftUrl: Schema.optional(Schema.String),
  failureReason: Schema.optional(Schema.String),
});

export const UpgradeGroup = HttpApiGroup.make("upgrade")
  .add(
    HttpApiEndpoint.post(
      "triggerUpgrade",
    )`/api/v1/machines/${HttpApiSchema.param("machineId", Schema.String)}/upgrade`
      .setPayload(UpgradeRequestPayload)
      .addSuccess(UpgradeResponse),
  )
  .middleware(CurrentUserAuthentication);
