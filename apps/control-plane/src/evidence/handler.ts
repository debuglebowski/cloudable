import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import { Db } from "../db/layer";
import { Api } from "../http/api";
import { queryEvidencePage } from "./service";

/**
 * `GET /api/v1/evidence?orgId=...` — a page of the normalised evidence
 * projection for an org, newest first (spec §18).
 *
 * DB failures are turned into defects (`Effect.orDie`) rather than a typed
 * endpoint error: this mirrors the placeholder posture of
 * `http/middleware/error-mapper.ts` elsewhere in this skeleton — a real
 * `not_found`/`validation`-shaped error taxonomy is for whichever unit
 * builds that mapper out, not something this one should invent solo.
 *
 * NOT ORG-SCOPED TO THE CALLER YET: `orgId` is trusted as given in the
 * query string because no auth middleware exists in this skeleton at all
 * (see `http/middleware/auth.ts`) — every endpoint here, not just this
 * one, is unauthenticated today. Once that middleware lands, this handler
 * MUST require it and read the org from `CurrentUserTag`, not the query
 * param, or any caller can read any org's evidence trail.
 */
export const EvidenceLive = HttpApiBuilder.group(Api, "evidence", (handlers) =>
  handlers.handle("list", ({ urlParams }) =>
    Effect.gen(function* () {
      const db = yield* Db;
      return yield* queryEvidencePage(db, {
        orgId: urlParams.orgId,
        cursor: urlParams.cursor,
        limit: urlParams.limit,
      });
    }).pipe(Effect.orDie),
  ),
);
