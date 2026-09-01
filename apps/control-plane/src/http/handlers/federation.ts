import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import { ulid } from "ulid";
import {
  TRUST_RULE_REJECTION_REASONS,
  type TrustRuleRejectionReason,
} from "../../services/federation/FakeAzureTrustRule";
import type { FederationError } from "../../services/federation/FederationService";
import { FederationService } from "../../services/federation/FederationService";
import { Api } from "../api";
import { CurrentUserTag } from "../middleware/auth";

/** Same list `FakeAzureTrustRule.ts` defines — see there for the single source of truth. */
const REJECTION_REASONS: ReadonlySet<string> = new Set(TRUST_RULE_REJECTION_REASONS);
type RejectionReason = TrustRuleRejectionReason;

const toErrorResponse = (code: string, message: string) =>
  ({ error: { code, message, requestId: ulid() } }) as const;

interface InfraErrorBody {
  readonly kind: "infra_error";
  readonly error: { readonly code: string; readonly message: string; readonly requestId: string };
}

interface RejectedErrorBody {
  readonly kind: "rejected";
  readonly error: { readonly code: string; readonly message: string; readonly requestId: string };
  readonly reason: RejectionReason;
}

/**
 * `FederationError.reason` covers both client-correctable rejections
 * (subject/issuer mismatch, expired, malformed) and internal infra faults
 * (sign/persist failure). The mint endpoint surfaces the former as a 422
 * with a structured `reason`, and the latter as a plain 500 — see the
 * `FederationErrorResponse` / `FederationRejectedResponse` split in
 * `../routes/federation.ts` for why these must stay two distinct
 * (`kind`-discriminated) shapes.
 */
const toMintErrorResponse = (
  error: FederationError,
): Effect.Effect<never, RejectedErrorBody | InfraErrorBody> => {
  const base = toErrorResponse(
    `federation_${error.reason}`,
    "The federation attempt was rejected.",
  );
  if (REJECTION_REASONS.has(error.reason)) {
    return Effect.fail({ kind: "rejected", ...base, reason: error.reason as RejectionReason });
  }
  return Effect.fail({ kind: "infra_error", ...base });
};

export const FederationLive = HttpApiBuilder.group(Api, "federation", (handlers) =>
  handlers
    .handle("discovery", () =>
      Effect.gen(function* () {
        const federation = yield* FederationService;
        return yield* federation.discoveryDocument();
      }),
    )
    .handle("jwks", () =>
      Effect.gen(function* () {
        const federation = yield* FederationService;
        return yield* federation.jwks().pipe(
          Effect.catchTag("FederationError", (error) =>
            Effect.fail({
              kind: "infra_error" as const,
              ...toErrorResponse(`federation_${error.reason}`, "Failed to load the JWKS document."),
            }),
          ),
        );
      }),
    )
    .handle("mint", ({ payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        const federation = yield* FederationService;
        // `orgId` comes from the authenticated session, never the request body — see
        // `MintFederationTokenRequest`'s own doc comment in `../routes/federation.ts` for
        // why (this endpoint mints a real signed credential and persists an `integrations`
        // row for whatever org it's told to).
        const outcome = yield* federation
          .federateCredential({ ...payload, orgId: currentUser.orgId })
          .pipe(Effect.catchTag("FederationError", toMintErrorResponse));
        return {
          subject: outcome.subject,
          subscriptionId: outcome.subscriptionId,
          token: outcome.token,
        };
      }),
    ),
);
