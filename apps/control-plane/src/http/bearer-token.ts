/**
 * Shared `Authorization: Bearer <token>` parsing for every bearer-authenticated raw handler
 * in this codebase (`/api/v1/agent/*`, `/api/v1/tunnel/signal`) — previously duplicated
 * verbatim in each handler file; extracted here once both existed so a third copy wasn't
 * added on top.
 */
const BEARER_PREFIX = "Bearer ";

export const bearerToken = (authorization: string | undefined): string | undefined =>
  authorization?.startsWith(BEARER_PREFIX) ? authorization.slice(BEARER_PREFIX.length) : undefined;
