import { HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";
import {
  ROLES_MANAGED_BY_IDP,
  ROLES_MANAGED_HTTP_STATUS,
  ROLES_MANAGED_MESSAGE,
} from "../../idp-roles/contract";

/**
 * 409: a role or approver change in Cloudable while roles come from the identity provider. The
 * shared contract's refusal, word for word: `code` is `ROLES_MANAGED_BY_IDP`, `message` is
 * "Roles are managed by your identity provider." The console and CLI show `message` as is.
 */
export class RolesManagedByIdpError extends Schema.TaggedError<RolesManagedByIdpError>()(
  "RolesManagedByIdpError",
  {
    code: Schema.Literal(ROLES_MANAGED_BY_IDP),
    message: Schema.Literal(ROLES_MANAGED_MESSAGE),
  },
  HttpApiSchema.annotations({ status: ROLES_MANAGED_HTTP_STATUS }),
) {}

export const rolesManagedByIdp = () =>
  new RolesManagedByIdpError({ code: ROLES_MANAGED_BY_IDP, message: ROLES_MANAGED_MESSAGE });
