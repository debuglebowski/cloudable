import { apiGet } from "@/lib/api-client";
import { CURRENT_ORG_ID } from "@/lib/current-org";

/**
 * Real, read-only person lookup — deliberately separate from `./people.ts`
 * (which stays a full mock: the People page's own create/edit/deactivate
 * flows have no real backend at all, see that file's header comment).
 *
 * This exists only so other domains that already have a real backend
 * (approvals, access, archive) can resolve a `personId` to an email for
 * display, via `apps/control-plane/src/http/routes/people.ts` — a minimal,
 * read-only list endpoint added specifically for that purpose, not a stand-in
 * for the People page's full surface.
 */
export interface DirectoryPerson {
  id: string;
  email: string;
  role: string;
  active: boolean;
}

export async function listPeople(): Promise<DirectoryPerson[]> {
  const res = await apiGet<{ items: DirectoryPerson[] }>(
    `/api/v1/people?orgId=${CURRENT_ORG_ID}`,
  );
  return res.items;
}
