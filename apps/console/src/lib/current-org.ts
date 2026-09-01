/**
 * `/api/v1/compliance/*`, `/api/v1/notifications*` (also `personId`), and
 * `/api/v1/organisation/packages` still take `orgId` as a plain,
 * unauthenticated wire param — real session auth (`http/middleware/
 * auth.ts`'s `CurrentUserAuthentication`) hasn't been wired to those route
 * groups yet (see that file's own "known gap" list). Every other page
 * derives its org from the real session now; these still need this fixed
 * id until that migration lands. `apps/control-plane/scripts/seed-demo.ts`
 * inserts its org with this exact id, so running the seed script against a
 * fresh database is enough to make these pages show data with no further
 * configuration.
 */
export const CURRENT_ORG_ID = "00000000-0000-0000-0000-000000000001";
