/**
 * People API layer.
 *
 * No backend People endpoints exist on `main` yet (no unit in this batch owns one). This module
 * mocks a realistic in-memory dataset behind the same function shapes a real API client would
 * have, so the page can be built and reviewed now. Swap the bodies below for `apiGet`/`apiPost`
 * calls (see `src/lib/api-client.ts`) once a People API lands — callers of this module shouldn't
 * need to change.
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

const MOCK_ORG_ID = "00000000-0000-0000-0000-000000000001";
const MOCK_LATENCY_MS = 200;

// ---- Mock dataset (clearly labeled sample data, not real people) ----
let mockPeople: Person[] = [
  {
    id: "10000000-0000-0000-0000-000000000001",
    orgId: MOCK_ORG_ID,
    email: "avery.chen@example.com",
    source: "manual",
    active: true,
    role: "admin",
    createdAt: "2026-01-14T09:12:00Z",
    deactivatedAt: null,
  },
  {
    id: "10000000-0000-0000-0000-000000000002",
    orgId: MOCK_ORG_ID,
    email: "jordan.reyes@example.com",
    source: "manual",
    active: true,
    role: "member",
    createdAt: "2026-02-02T15:40:00Z",
    deactivatedAt: null,
  },
  {
    id: "10000000-0000-0000-0000-000000000003",
    orgId: MOCK_ORG_ID,
    email: "priya.nair@example.com",
    source: "scim",
    active: true,
    role: "member",
    createdAt: "2026-03-20T08:05:00Z",
    deactivatedAt: null,
  },
  {
    id: "10000000-0000-0000-0000-000000000004",
    orgId: MOCK_ORG_ID,
    email: "sam.okafor@example.com",
    source: "scim",
    active: false,
    role: "member",
    createdAt: "2025-11-30T11:00:00Z",
    deactivatedAt: "2026-06-01T00:00:00Z",
  },
  {
    id: "10000000-0000-0000-0000-000000000005",
    orgId: MOCK_ORG_ID,
    email: "morgan.lee@example.com",
    source: "manual",
    active: false,
    role: "billing",
    createdAt: "2025-09-05T13:22:00Z",
    deactivatedAt: "2026-04-11T00:00:00Z",
  },
];

function delay<T>(value: T, ms = MOCK_LATENCY_MS): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

export async function listPeople(): Promise<Person[]> {
  return delay(mockPeople.map((person) => ({ ...person })));
}

export interface AddPersonInput {
  email: string;
  role: string;
}

/** Manually-added people always start active with `source: "manual"`. */
export async function addPerson(input: AddPersonInput): Promise<Person> {
  const normalizedEmail = input.email.trim().toLowerCase();
  if (mockPeople.some((person) => person.email.toLowerCase() === normalizedEmail)) {
    throw new Error(`${input.email} is already in People`);
  }
  const person: Person = {
    id: crypto.randomUUID(),
    orgId: MOCK_ORG_ID,
    email: input.email,
    role: input.role,
    source: "manual",
    active: true,
    createdAt: new Date().toISOString(),
    deactivatedAt: null,
  };
  mockPeople = [...mockPeople, person];
  return delay({ ...person });
}

export interface UpdatePersonInput {
  email?: string;
  role?: string;
}

/** Only valid for `source: "manual"` people — SCIM-synced fields are never edited here. */
export async function updatePerson(id: string, patch: UpdatePersonInput): Promise<Person> {
  let updated: Person | undefined;
  mockPeople = mockPeople.map((person) => {
    if (person.id !== id || !isManuallyManaged(person)) return person;
    updated = { ...person, ...patch };
    return updated;
  });
  if (!updated) throw new Error(`Person ${id} not found or not manually managed`);
  return delay({ ...updated });
}

/**
 * Sets active/deactivated status. Deactivating stamps `deactivatedAt`; reactivating clears it.
 * Only valid for `source: "manual"` people — once SCIM is connected, active status for synced
 * people is driven by the IdP, not toggled here.
 */
export async function setPersonActive(id: string, active: boolean): Promise<Person> {
  let updated: Person | undefined;
  mockPeople = mockPeople.map((person) => {
    if (person.id !== id || !isManuallyManaged(person)) return person;
    updated = {
      ...person,
      active,
      deactivatedAt: active ? null : new Date().toISOString(),
    };
    return updated;
  });
  if (!updated) throw new Error(`Person ${id} not found or not manually managed`);
  return delay({ ...updated });
}
