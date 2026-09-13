// ---------------------------------------------------------------------------
// Who the stored session belongs to.
//
// Several endpoints still take `orgId` (and `notifications` a `personId`) as
// plain parameters rather than deriving them from the session — see the
// comments on `http/routes/compliance.ts` and `organisation.ts`. The console
// answers that with a hardcoded org id; this CLI instead reads the caller's
// own `people` row, which the session middleware has already resolved by
// email, so nothing here assumes a seed org. Cached for the process: several
// commands need it more than once, and it cannot change mid-command.
// ---------------------------------------------------------------------------
import { CliError, EXIT } from "./errors";
import { authenticatedApiRequest, query } from "./http-client";
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

export async function currentIdentity(): Promise<Identity> {
  if (cached) return cached;
  const session = requireSession();
  const people = await listPeople();
  const match = people.find((p) => p.email.toLowerCase() === session.email.toLowerCase());
  if (!match) {
    throw new CliError(
      `signed in as ${session.email}, but that address has no person record.\n\nAsk an admin to add it with \`cloudable people create --email ${session.email} --role member\`.`,
      EXIT.notFound,
    );
  }
  cached = { personId: match.id, orgId: match.orgId, email: match.email, role: match.role };
  return cached;
}

/** The `{type: "person", id}` actor the organisation endpoints want on every write. */
export async function currentActor(): Promise<{ type: "person"; id: string }> {
  const { personId } = await currentIdentity();
  return { type: "person", id: personId };
}

export async function fetchOrg(): Promise<OrgWire> {
  const { orgId } = await currentIdentity();
  return authenticatedApiRequest<OrgWire>(`/api/v1/organisation${query({ orgId })}`);
}
