import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import { issueCliAuthCode } from "../../services/CliAuthCode";
import { Api } from "../api";
import { CurrentUserTag } from "../middleware/auth";

export const CliAuthLive = HttpApiBuilder.group(Api, "cliAuth", (handlers) =>
  handlers.handle("mintCode", () =>
    Effect.gen(function* () {
      const currentUser = yield* CurrentUserTag;
      return {
        code: issueCliAuthCode({ personId: currentUser.personId, orgId: currentUser.orgId }),
      };
    }),
  ),
);
