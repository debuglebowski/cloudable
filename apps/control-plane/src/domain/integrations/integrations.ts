import { integrations } from "@cloudable/schema";
import { and, eq, isNull } from "drizzle-orm";
import { Data, Effect } from "effect";
import { Db } from "../../db/layer";

/**
 * Real backend for the Integrations page (IdP/cloud/secret-
 * store connection pointers — never a credential, see the `integrations`
 * table's own doc comment "Federation only — no credentials stored here").
 *
 * `idp`/`secret_store` stay single-slot per org: connecting a new one
 * soft-removes any prior one of that kind. `cloud` is multi-slot, keyed by
 * `provider` — azure/docker/fake can all be connected simultaneously (a
 * per-machine choice needs real alternatives to choose between), so
 * connecting one only replaces a prior row for that *same* provider, never
 * a different one.
 */

export type IntegrationRow = typeof integrations.$inferSelect;
export type IntegrationKind = "idp" | "cloud" | "secret_store";
export type IntegrationProvider = "azure" | "docker" | "fake";

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

/** Whether `provider` is one of this org's enabled `kind: "cloud"` rows —
 * the real enforcement behind the machine-creation Provider dropdown,
 * called from `MachineService.create` so a raw API call can't pick a
 * provider the org never enabled just because the UI only ever offers
 * enabled ones (same posture as the region/image catalog check). */
export const isProviderEnabled = (
  orgId: string,
  provider: IntegrationProvider,
): Effect.Effect<boolean, IntegrationsDbError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* dbTry(
      () =>
        db
          .select({ id: integrations.id })
          .from(integrations)
          .where(
            and(
              eq(integrations.orgId, orgId),
              eq(integrations.kind, "cloud"),
              eq(integrations.provider, provider),
              isNull(integrations.removedAt),
            ),
          )
          .limit(1),
      "read_provider_enabled_failed",
    );
    return rows.length > 0;
  });

export interface ConnectIntegrationInput {
  orgId: string;
  kind: IntegrationKind;
  /** Required (and only meaningful) when `kind === "cloud"` — see this
   * module's header comment on why cloud is multi-slot by provider while
   * idp/secret_store stay single-slot per kind. */
  provider?: IntegrationProvider | undefined;
  identifier: string;
  config: Record<string, unknown>;
}

export const connectIntegration = (
  input: ConnectIntegrationInput,
): Effect.Effect<IntegrationRow, IntegrationsDbError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    // Replace-by-(kind, provider) when a provider is given (cloud), else
    // replace-by-kind (idp/secret_store) — in one transaction: soft-remove
    // whatever matched, then insert the new one. Not just an
    // insert-then-cleanup pair, so a mid-write crash can never leave two
    // live rows of the same slot.
    const row = yield* dbTry(
      () =>
        db.transaction(async (tx) => {
          const replaceScope = input.provider
            ? and(
                eq(integrations.orgId, input.orgId),
                eq(integrations.kind, input.kind),
                eq(integrations.provider, input.provider),
                isNull(integrations.removedAt),
              )
            : and(
                eq(integrations.orgId, input.orgId),
                eq(integrations.kind, input.kind),
                isNull(integrations.removedAt),
              );
          await tx.update(integrations).set({ removedAt: new Date() }).where(replaceScope);
          const [inserted] = await tx
            .insert(integrations)
            .values({
              orgId: input.orgId,
              kind: input.kind,
              provider: input.provider ?? null,
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
