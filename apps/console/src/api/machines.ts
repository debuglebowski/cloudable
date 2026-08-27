import type { ApiErrorBody } from "@cloudable/contracts";

// TODO: replace Machine / ManifestEntry / DriftInfo below with real types from
// `@cloudable/contracts/domains/machines` once unit 2 (control-plane backend) merges.
// As of this branch, `packages/contracts/src/domains/machines.ts` is still just a
// `.gitkeep` and `apps/control-plane/src/http/routes/machines.ts` does not exist yet,
// so this whole module is a mock: field names are guessed from
// `packages/schema/src/tables/machine.ts` / `.../tables/setting.ts`, and all data below
// is realistic sample data, not a real API client. Swap `listMachines` etc. for
// `apiGet`/`apiPost` calls once the real endpoints land.

export type MachineState =
  | "provisioning"
  | "running"
  | "stopped"
  | "archived_restorable"
  | "archived_expired"
  | "error";

export interface Machine {
  id: string;
  orgId: string;
  templateId: string | null;
  ownerPersonId: string | null;
  name: string;
  region: string;
  sizeSku: string;
  image: string;
  state: MachineState;
  lastVerifiedAt: string | null;
  archivedAt: string | null;
}

export type SettingLevel = "org" | "template" | "machine";

export interface ManifestEntry {
  package: string;
  /** `null` means "any" version — no pin. */
  version: string | null;
  source: SettingLevel;
  /** Org-level pin: cannot be overridden below (spec §6). */
  pinned: boolean;
  /** Count of machines that override this entry below the level shown here. */
  overriddenBelow?: number;
}

export type DriftStatus = "clean" | "detected" | "unknown";

/**
 * Shaped after `machine.drift_detected`'s payload in
 * `packages/events/src/domains/machine.ts` (`{ undeclaredPackages, undeclaredPorts }`).
 * `status: "unknown"` is distinct from `"clean"` — it means no drift event data exists
 * yet for this machine (never reconciled, or currently stopped), not that drift was
 * checked and found absent.
 */
export interface DriftInfo {
  status: DriftStatus;
  undeclaredPackages?: string[];
  undeclaredPorts?: number[];
  detectedAt?: string;
}

export class ManifestOverrideError extends Error {
  readonly body: ApiErrorBody;
  constructor(body: ApiErrorBody) {
    super(body.error.message);
    this.name = "ManifestOverrideError";
    this.body = body;
  }
}

export const machinesKeys = {
  all: ["machines"] as const,
  lists: () => [...machinesKeys.all, "list"] as const,
  list: (orgId?: string) => [...machinesKeys.lists(), orgId ?? "current"] as const,
  details: () => [...machinesKeys.all, "detail"] as const,
  detail: (machineId: string) => [...machinesKeys.details(), machineId] as const,
  manifest: (machineId: string) => [...machinesKeys.all, "manifest", machineId] as const,
  drift: (machineId: string) => [...machinesKeys.all, "drift", machineId] as const,
};

function delay<T>(value: T, ms = 250): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

const MOCK_ORG_ID = "org_9f2c1a";

const MOCK_MACHINES: Machine[] = [
  {
    id: "m_web01",
    orgId: MOCK_ORG_ID,
    templateId: "tpl_web",
    ownerPersonId: "person_amelia",
    name: "web-01",
    region: "westeurope",
    sizeSku: "Standard_B2s",
    image: "ubuntu-22.04-lts",
    state: "running",
    lastVerifiedAt: minutesAgo(4),
    archivedAt: null,
  },
  {
    id: "m_ci03",
    orgId: MOCK_ORG_ID,
    templateId: "tpl_ci",
    ownerPersonId: "person_devon",
    name: "build-agent-03",
    region: "eastus",
    sizeSku: "Standard_D4s_v5",
    image: "ubuntu-24.04-lts",
    state: "error",
    lastVerifiedAt: minutesAgo(130),
    archivedAt: null,
  },
  {
    id: "m_sandbox",
    orgId: MOCK_ORG_ID,
    templateId: null,
    ownerPersonId: "person_priya",
    name: "data-sandbox",
    region: "westeurope",
    sizeSku: "Standard_E8s_v5",
    image: "ubuntu-22.04-lts",
    state: "provisioning",
    lastVerifiedAt: null,
    archivedAt: null,
  },
  {
    id: "m_legacy",
    orgId: MOCK_ORG_ID,
    templateId: "tpl_web",
    ownerPersonId: null,
    name: "legacy-app-node",
    region: "northeurope",
    sizeSku: "Standard_B4ms",
    image: "debian-12",
    state: "archived_restorable",
    lastVerifiedAt: minutesAgo(60 * 24 * 40),
    archivedAt: minutesAgo(60 * 24 * 30),
  },
  {
    id: "m_kalledev",
    orgId: MOCK_ORG_ID,
    templateId: "tpl_dev",
    ownerPersonId: "person_kalle",
    name: "kalle-dev",
    region: "westeurope",
    sizeSku: "Standard_D2s_v5",
    image: "ubuntu-24.04-lts",
    state: "running",
    lastVerifiedAt: minutesAgo(0.3),
    archivedAt: null,
  },
  {
    id: "m_cirunner02",
    orgId: MOCK_ORG_ID,
    templateId: "tpl_ci",
    ownerPersonId: "person_devon",
    name: "ci-runner-02",
    region: "eastus",
    sizeSku: "Standard_D4s_v5",
    image: "ubuntu-24.04-lts",
    state: "stopped",
    lastVerifiedAt: minutesAgo(360),
    archivedAt: null,
  },
];

// Mutated in place by `overrideManifestEntry` so a demo session sees its own edits
// reflected back — this is a mock store standing in for the real backend, not app state.
const MOCK_MANIFESTS: Record<string, ManifestEntry[]> = {
  m_web01: [
    { package: "docker", version: "24.0", source: "org", pinned: true },
    { package: "nodejs", version: "20", source: "template", pinned: false, overriddenBelow: 2 },
    { package: "nginx", version: null, source: "org", pinned: false },
    { package: "ripgrep", version: "13.0", source: "machine", pinned: false },
  ],
  m_ci03: [
    { package: "docker", version: "24.0", source: "org", pinned: true },
    { package: "python3", version: "3.11", source: "template", pinned: false },
  ],
  m_sandbox: [
    { package: "docker", version: "24.0", source: "org", pinned: true },
    { package: "python3", version: null, source: "org", pinned: false },
  ],
  m_legacy: [
    { package: "docker", version: "24.0", source: "org", pinned: true },
    { package: "nodejs", version: "18", source: "machine", pinned: false },
  ],
  m_kalledev: [
    { package: "docker", version: "24.0", source: "org", pinned: true },
    { package: "nodejs", version: "20", source: "template", pinned: false, overriddenBelow: 2 },
    { package: "git", version: null, source: "org", pinned: false },
  ],
  m_cirunner02: [
    { package: "docker", version: "24.0", source: "org", pinned: true },
    { package: "python3", version: "3.11", source: "template", pinned: false },
  ],
};

const MOCK_DRIFT: Record<string, DriftInfo> = {
  m_web01: { status: "clean" },
  m_ci03: {
    status: "detected",
    undeclaredPackages: ["ripgrep", "htop"],
    undeclaredPorts: [8081],
    detectedAt: minutesAgo(130),
  },
  // Never verified yet — no reconcile pass has run, so there is no drift event to show.
  m_sandbox: { status: "unknown" },
  m_legacy: { status: "clean" },
  m_kalledev: { status: "clean" },
  // Stopped machines don't reconcile while stopped, so their drift status goes stale too.
  m_cirunner02: { status: "unknown" },
};

export async function listMachines(): Promise<Machine[]> {
  return delay([...MOCK_MACHINES]);
}

export async function getMachine(machineId: string): Promise<Machine | undefined> {
  return delay(MOCK_MACHINES.find((m) => m.id === machineId));
}

export async function getMachineManifest(machineId: string): Promise<ManifestEntry[]> {
  return delay([...(MOCK_MANIFESTS[machineId] ?? [])]);
}

export async function getMachineDrift(machineId: string): Promise<DriftInfo> {
  return delay(MOCK_DRIFT[machineId] ?? { status: "unknown" });
}

/**
 * Mock mutation standing in for `PATCH /machines/:id/manifest/:package`. Rejects pinned
 * entries with a 422-shaped `ApiErrorBody`, mirroring spec §6: "Attempting to override
 * [a pinned entry] is a validation error at edit time, not a silent no-op at reconcile."
 */
export async function overrideManifestEntry(
  machineId: string,
  packageName: string,
  nextVersion: string | null,
): Promise<ManifestEntry> {
  await delay(undefined, 200);

  const manifest = MOCK_MANIFESTS[machineId];
  const entry = manifest?.find((e) => e.package === packageName);
  if (!manifest || !entry) {
    throw new ManifestOverrideError({
      error: {
        code: "NOT_FOUND",
        message: `No manifest entry named "${packageName}" on this machine.`,
        requestId: `mock_${Date.now()}`,
      },
    });
  }

  if (entry.pinned && entry.source !== "machine") {
    throw new ManifestOverrideError({
      error: {
        code: "SETTING_PINNED",
        message: `"${packageName}" is pinned at the organisation level and cannot be overridden below org.`,
        requestId: `mock_${Date.now()}`,
      },
    });
  }

  entry.version = nextVersion;
  entry.source = "machine";
  return { ...entry };
}
