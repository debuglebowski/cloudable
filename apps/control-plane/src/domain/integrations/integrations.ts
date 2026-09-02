import { integrations } from "@cloudable/schema";
import { and, eq, isNull } from "drizzle-orm";
import { Data, Effect } from "effect";
import { Db } from "../../db/layer";

/**
 * Real backend for the Integrations page (IdP/cloud/secret-
 * store connection pointers — never a credential, see the `integrations`
 * table's own doc comment "Federation only — no credentials stored here").
 * At most one live (non-removed) integration per `kind` per org: connecting
 * a new one of a kind soft-removes any prior one of that kind, mirroring
 * `apps/console/src/api/integrations.ts`'s mock exactly (that mock's
 * "connect" already replaced-by-kind, correctly, from the start).
 */

export type IntegrationRow = typeof integrations.$inferSelect;
export type IntegrationKind = "idp" | "cloud" | "secret_store";

export class IntegrationsDbError extends Data.TaggedError("IntegrationsDbError")<{
  reason: string;
  cause?: unknown;
}> {}

const dbTry = <A>(thunk: () => Promise<A>, reason: string): Effect.Effect<A, IntegrationsDbError> =>
  Effect.tryPromise({ try: thunk, catch: (cause) => new IntegrationsDbError({ reason, cause }) });

export const listActiveIntegrations = (
  orgId: string,
): Effect.Effect<IntegrationRow[], IntegrationsDbError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* dbTry(
      () =>
        db
          .select()
          .from(integrations)
          .where(and(eq(integrations.orgId, orgId), isNull(integrations.removedAt))),
      "list_integrations_failed",
    );
  });

export interface ConnectIntegrationInput {
  orgId: string;
  kind: IntegrationKind;
  identifier: string;
  config: Record<string, unknown>;
}

export const connectIntegration = (
  input: ConnectIntegrationInput,
): Effect.Effect<IntegrationRow, IntegrationsDbError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    // Replace-by-kind, in one transaction: soft-remove whatever was
    // connected for this kind, then insert the new one. Not just an
    // insert-then-cleanup pair, so a mid-write crash can never leave two
    // live rows of the same kind.
    const row = yield* dbTry(
      () =>
        db.transaction(async (tx) => {
          await tx
            .update(integrations)
            .set({ removedAt: new Date() })
            .where(
              and(
                eq(integrations.orgId, input.orgId),
                eq(integrations.kind, input.kind),
                isNull(integrations.removedAt),
              ),
            );
          const [inserted] = await tx
            .insert(integrations)
            .values({
              orgId: input.orgId,
              kind: input.kind,
              identifier: input.identifier,
              config: input.config,
            })
            .returning();
          if (!inserted) throw new Error("insert returned no row");
          return inserted;
        }),
      "connect_integration_failed",
    );
    return row;
  });

// `orgId` scopes the update to that org — an integration belonging to a
// DIFFERENT org is simply not matched by the `where`, so the update
// affects zero rows rather than someone else's integration. Same
// non-leaking posture as everywhere else in this build; unlike a fetch,
// there's no separate row to compare against, so the check is folded
// straight into the `where` clause instead of a preceding lookup.
export const disconnectIntegration = (
  integrationId: string,
  orgId: string,
): Effect.Effect<void, IntegrationsDbError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* dbTry(
      () =>
        db
          .update(integrations)
          .set({ removedAt: new Date() })
          .where(and(eq(integrations.id, integrationId), eq(integrations.orgId, orgId))),
      "disconnect_integration_failed",
    );
  });
