import { ApiError, apiGet, apiPatch, apiPost } from "@/lib/api-client";

/**
 * People API layer — wired to the real `apps/control-plane/src/http/routes/
 * people.ts`, added specifically to back this page (create/update/
 * deactivate), not just the read-only directory lookup other domains use
 * (`@/api/people-directory.ts`).
 */

export type PersonSource = "manual" | "scim";

export interface Person {
  id: string;
  orgId: string;
  email: string;
  source: PersonSource;
  active: boolean;
  role: string;
  createdAt: string;
  deactivatedAt: string | null;
}

/** Domain-first query key tuples, per project convention. */
export const peopleKeys = {
  all: ["people"] as const,
  list: () => [...peopleKeys.all, "list"] as const,
};

/** The single source of truth for "is this row editable here" — used by the API and the page. */
export function isManuallyManaged(person: Person): boolean {
  return person.source === "manual";
}

export async function listPeople(): Promise<Person[]> {
  const res = await apiGet<{ items: Person[] }>("/api/v1/people");
  return res.items;
}

export interface AddPersonInput {
  email: string;
  role: string;
}

/** Manually-added people always start active with `source: "manual"` — enforced server-side. */
export async function addPerson(input: AddPersonInput): Promise<Person> {
  try {
    return await apiPost<Person>("/api/v1/people", {
      email: input.email,
      role: input.role,
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      throw new Error(`${input.email} is already in People`);
    }
    throw err;
  }
}

export interface UpdatePersonInput {
  email?: string;
  role?: string;
}

/** Only valid for `source: "manual"` people — SCIM-synced fields are never edited here
 * (the real endpoint rejects with a 409, translated to a plain message below). */
export async function updatePerson(id: string, patch: UpdatePersonInput): Promise<Person> {
  try {
    return await apiPatch<Person>(`/api/v1/people/${id}`, patch);
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      throw new Error("This person is synced from an IdP and can't be edited here.");
    }
    throw err;
  }
}

/**
 * Sets active/deactivated status. Deactivating stamps `deactivatedAt`; reactivating clears it.
 * Only valid for `source: "manual"` people — once SCIM is connected, active status for synced
 * people is driven by the IdP, not toggled here.
 */
export async function setPersonActive(id: string, active: boolean): Promise<Person> {
  try {
    return await apiPatch<Person>(`/api/v1/people/${id}/active`, { active });
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      throw new Error("This person is synced from an IdP and can't be deactivated here.");
    }
    throw err;
  }
}
