/**
 * There is no auth/session system in this build (no unit owns one yet —
 * see `apps/control-plane/src/http/middleware/auth.ts`), so there is no
 * real "who is using the console right now" to derive a personId from.
 * Owner notifications ("owner notified") are inherently
 * per-person, though, unlike every other page here (which is only ever
 * org-scoped — see `./current-org.ts`'s identical rationale) — this fixed
 * id stands in for "the signed-in person" until a real auth unit lands.
 * `apps/control-plane/scripts/seed-demo.ts` inserts Jordan (owner of
 * staging-07, the machine the demo elevation targets) with this exact id,
 * so a fresh seed is enough to see a real unread notification with zero
 * further configuration.
 */
export const CURRENT_PERSON_ID = "00000000-0000-0000-0000-000000000002";

/** Jordan's own email — same stopgap as `CURRENT_PERSON_ID` above. Needed
 * wherever a still-unmigrated endpoint takes an `idpIdentity` binding
 * alongside a raw `personId` (`access.ts`'s `mintSession`; see
 * `api/access.ts`), not just an id. */
export const CURRENT_PERSON_EMAIL = "jordan.blake@acme.com";
