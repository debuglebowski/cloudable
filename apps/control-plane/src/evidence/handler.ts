import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import { Db } from "../db/layer";
import { Api } from "../http/api";
import { CurrentUserTag } from "../http/middleware/auth";
import { queryEvidencePage } from "./service";

/**
 * `GET /api/v1/evidence` — a page of the normalised evidence projection for
 * the caller's own org, newest first.
 *
 * DB failures are turned into defects (`Effect.orDie`) rather than a typed
 * endpoint error: this mirrors the placeholder posture of
 * `http/middleware/error-mapper.ts` elsewhere in this skeleton — a real
 * `not_found`/`validation`-shaped error taxonomy is for whichever unit
 * builds that mapper out, not something this one should invent solo.
 */
export const EvidenceLive = HttpApiBuilder.group(Api, "evidence", (handlers) =>
  handlers.handle("list", ({ urlParams }) =>
    Effect.gen(function* () {
      const currentUser = yield* CurrentUserTag;
      const db = yield* Db;
      return yield* queryEvidencePage(db, {
        orgId: currentUser.orgId,
        cursor: urlParams.cursor,
        limit: urlParams.limit,
      });
    }).pipe(Effect.orDie),
  ),
);
