import { authenticatedApiRequest } from "./http-client";
import { requireSession } from "./session";

export interface PersonWire {
  id: string;
  orgId: string;
  email: string;
  source: "manual" | "scim";
  active: boolean;
  role: string;
  createdAt: string;
  deactivatedAt: string | null;
}

export interface OrgWire {
  id: string;
  name: string;
  approvalModes: Record<string, "none" | "single" | "dual">;
  loggingTier: 1 | 2 | 3;
  loggingTierOverrideCount: number;
  retentionDefaultDays: number;
  retentionLocation: "customer" | "cloudable_sweden_central";
}

export interface Identity {
  readonly personId: string;
  readonly orgId: string;
  readonly email: string;
  readonly role: string;
}

export async function listPeople(): Promise<PersonWire[]> {
  const res = await authenticatedApiRequest<{ items: PersonWire[] }>("/api/v1/people");
  return [...res.items];
}

let cached: Identity | undefined;

/**
 * `GET /api/v1/me` — the control plane resolved the caller from the
 * credential before the handler ran, so it can just say who that is.
 *
 * This used to list every person in the org and match on the email stored
 * beside the session. That could not survive the move to a bearer token: the
 * token carries a person id and the CLI never learns an email of its own, so
 * there was nothing to match on (and `CLOUDABLE_TOKEN`, which has no stored
 * email at all, could never have worked). It also meant a self-lookup needed
 * permission to read the whole org.
 */
export async function currentIdentity(): Promise<Identity> {
  if (cached) return cached;
  requireSession();
  const me = await authenticatedApiRequest<PersonWire>("/api/v1/me");
  cached = { personId: me.id, orgId: me.orgId, email: me.email, role: me.role };
  return cached;
}

/** The `{type: "person", id}` actor the organisation endpoints want on every write. */
export async function currentActor(): Promise<{ type: "person"; id: string }> {
  const { personId } = await currentIdentity();
  return { type: "person", id: personId };
}

export async function fetchOrg(): Promise<OrgWire> {
  return authenticatedApiRequest<OrgWire>("/api/v1/organisation");
}
