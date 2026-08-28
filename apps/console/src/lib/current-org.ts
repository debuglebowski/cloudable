/**
 * There is no auth/org-selection system in this build (no unit owns it), so
 * every real-data page targets one fixed demo org rather than inventing a
 * fake "current org" concept. `apps/control-plane/scripts/seed-demo.ts`
 * inserts its org with this exact id, so running the seed script against a
 * fresh database is enough to make every real-backed page show data with no
 * further configuration.
 */
export const CURRENT_ORG_ID = "00000000-0000-0000-0000-000000000001";
