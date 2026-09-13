import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";
import {
  PersonAlreadyExistsError,
  PersonNotFoundError,
  PersonNotManuallyManagedError,
} from "../../domain/people/people";
import { CurrentUserAuthentication } from "../middleware/auth";

// Real backend for the People page ("People is top-level and
// fully editable" when SCIM is absent). `source`/`active`/`deactivatedAt`
// mirror `packages/schema/src/tables/person.ts` exactly.

const PersonSource = Schema.Literal("manual", "scim");

const Person = Schema.Struct({
  id: Schema.String,
  orgId: Schema.String,
  email: Schema.String,
  source: PersonSource,
  active: Schema.Boolean,
  role: Schema.String,
  createdAt: Schema.String,
  deactivatedAt: Schema.NullOr(Schema.String),
});

const PersonIdPath = Schema.Struct({ id: Schema.String });

const ListPeopleResponse = Schema.Struct({ items: Schema.Array(Person) });

// `orgId` is gone from the wire — derived from `CurrentUserTag.orgId`.
const CreatePersonPayload = Schema.Struct({
  email: Schema.String.pipe(Schema.minLength(1)),
  role: Schema.String.pipe(Schema.minLength(1)),
});

const UpdatePersonPayload = Schema.Struct({
  email: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  role: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
});

const SetActivePayload = Schema.Struct({ active: Schema.Boolean });

export const PeopleGroup = HttpApiGroup.make("people")
  // Who the caller is, according to the credential they just presented.
  // The CLI needs this because a bearer token is all it holds — it has no
  // email of its own to match on, and listing an entire org to find yourself
  // is both a scan and a permission the caller may not have.
  .add(HttpApiEndpoint.get("me", "/api/v1/me").addSuccess(Person))
  .add(HttpApiEndpoint.get("list", "/api/v1/people").addSuccess(ListPeopleResponse))
  .add(
    HttpApiEndpoint.post("create", "/api/v1/people")
      .setPayload(CreatePersonPayload)
      .addSuccess(Person, { status: 201 })
      .addError(PersonAlreadyExistsError, { status: 409 }),
  )
  .add(
    HttpApiEndpoint.patch("update", "/api/v1/people/:id")
      .setPath(PersonIdPath)
      .setPayload(UpdatePersonPayload)
      .addSuccess(Person)
      .addError(PersonNotFoundError, { status: 404 })
      .addError(PersonNotManuallyManagedError, { status: 409 }),
  )
  .add(
    HttpApiEndpoint.patch("setActive", "/api/v1/people/:id/active")
      .setPath(PersonIdPath)
      .setPayload(SetActivePayload)
      .addSuccess(Person)
      .addError(PersonNotFoundError, { status: 404 })
      .addError(PersonNotManuallyManagedError, { status: 409 }),
  )
  .middleware(CurrentUserAuthentication);
