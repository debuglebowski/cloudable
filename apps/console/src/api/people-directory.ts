import { apiGet } from "@/lib/api-client";

/**
 * Real, read-only person lookup — deliberately separate from `./people.ts`
 * (the People page's own full create/edit/deactivate surface). Both now
 * have a real backend; this one just exists so other domains (approvals,
 * access, archive) can resolve a `personId` to an email for display via
 * the same `apps/control-plane/src/http/routes/people.ts` `list` endpoint,
 * without pulling in `./people.ts`'s edit-oriented types.
 */
export interface DirectoryPerson {
  id: string;
  email: string;
  role: string;
  active: boolean;
}

export async function listPeople(): Promise<DirectoryPerson[]> {
  const res = await apiGet<{ items: DirectoryPerson[] }>("/api/v1/people");
  return res.items;
}
