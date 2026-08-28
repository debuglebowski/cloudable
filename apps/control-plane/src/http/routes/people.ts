import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";

// Deliberately minimal — a read-only, org-scoped list, not the People page's
// full CRUD surface (no unit in this build owns creating/editing/
// deactivating a person over HTTP; the People console page is still mocked
// for that reason). This exists only so other real domains that reference a
// personId (approvals, sessions, elevations, machine ownership) have a way
// to resolve it to an email for display, instead of showing a raw UUID or —
// worse — a console needing to invent a fake identity to act as.

const PersonSummary = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  role: Schema.String,
  active: Schema.Boolean,
});

const ListPeopleUrlParams = Schema.Struct({ orgId: Schema.String });
const ListPeopleResponse = Schema.Struct({ items: Schema.Array(PersonSummary) });

export const PeopleGroup = HttpApiGroup.make("people").add(
  HttpApiEndpoint.get("list", "/api/v1/people").setUrlParams(ListPeopleUrlParams).addSuccess(
    ListPeopleResponse,
  ),
);
