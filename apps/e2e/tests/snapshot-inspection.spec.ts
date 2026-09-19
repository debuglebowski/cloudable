import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { e2eConfig } from "../setup/config";
import { connect, schema } from "../setup/db";
import { E2E_PASSWORD } from "../setup/global-setup";

/**
 * Browsing an archived machine's snapshot, end to end through the console.
 *
 * Seeds its OWN org and login rather than reusing `global-setup.ts`'s shared one, because
 * this needs archived machines and `login.spec.ts` asserts that its org has none. Tests
 * share that fixture and run serially, so seeding into it would break an unrelated test.
 *
 * Three archived machines, because the interesting behaviour is the difference between
 * them:
 *
 *   owned     — the signed-in person owns it, so they may look
 *   orphaned  — offboarding cleared the owner, so nobody owns it and they may NOT,
 *               which is the case the whole access gate exists for
 *   empty     — captured no disks, so the action greys out with a stated reason
 *
 * The control plane must be running with FAKE_SNAPSHOT_IMAGE_PATH pointed at a real ext4
 * image for the listing assertions; without it the open succeeds and the first listing
 * fails, so those are skipped rather than reported as a product failure.
 */
const hasImage = !!process.env.FAKE_SNAPSHOT_IMAGE_PATH;

// Suffixed per run so a machine name can never collide with a previous run's leftovers.
const suffix = randomUUID().slice(0, 8);
const NAMES = {
  owned: `insp-owned-${suffix}`,
  orphaned: `insp-orphaned-${suffix}`,
  empty: `insp-empty-${suffix}`,
  // A RUNNING machine holding a manual snapshot. The Archive page lists archived machines
  // and picks each one's archive-trigger snapshot, so this row appears only on the
  // machine's own Snapshots tab -- the case that had no way into the browser at all.
  live: `insp-live-${suffix}`,
};

let email = "";
let orgId = "";
let personId = "";
let authUserId = "";
/** Machine ids by role. Every test drives a machine's own Snapshots tab now: the Archive
 * page is a read-only fleet overview and carries no actions at all. */
const ids: Record<keyof typeof NAMES, string> = {
  owned: "",
  orphaned: "",
  empty: "",
  live: "",
};

test.beforeAll(async () => {
  const { client, db } = connect();
  try {
    const [org] = await db
      .insert(schema.orgs)
      .values({ name: `insp-${randomUUID()}` })
      .returning();
    if (!org) throw new Error("seed failed");
    orgId = org.id;

    email = `insp-${randomUUID()}@cloudable.test`;
    const [person] = await db
      .insert(schema.people)
      .values({ orgId, email, source: "manual", active: true, role: "owner" })
      .returning();
    if (!person) throw new Error("seed failed");
    personId = person.id;

    // The real credential path, same as `global-setup.ts`.
    const res = await fetch(`${e2eConfig.controlPlaneUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: e2eConfig.consoleUrl },
      body: JSON.stringify({ email, password: E2E_PASSWORD, name: "Inspection Test" }),
    });
    if (!res.ok) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
    authUserId = ((await res.json()) as { user: { id: string } }).user.id;

    const machine = async (name: string, ownerPersonId: string | null, live = false) => {
      const [row] = await db
        .insert(schema.machines)
        .values({
          orgId,
          name,
          provider: "fake",
          region: "eastus",
          sizeSku: "Standard_B2s",
          image: "ubuntu-24.04",
          ownerPersonId,
          state: live ? "running" : "archived_restorable",
          archivedAt: live ? null : new Date(),
        })
        .returning();
      if (!row) throw new Error("seed failed");
      return row;
    };
    const snapshot = async (
      machineId: string,
      disks: unknown[],
      trigger: "archive" | "manual" = "archive",
    ) => {
      await db.insert(schema.snapshots).values({
        orgId,
        machineId,
        trigger,
        retentionDays: 30,
        expiresAt: new Date(Date.now() + 20 * 86_400_000),
        capturedDisks: disks as never,
      });
    };

    const disk = [{ kind: "data", externalId: `e2e-${randomUUID()}`, sizeBytes: 1024 }];
    ids.owned = (await machine(NAMES.owned, personId)).id;
    await snapshot(ids.owned, disk);
    ids.orphaned = (await machine(NAMES.orphaned, null)).id;
    await snapshot(ids.orphaned, disk);
    ids.empty = (await machine(NAMES.empty, personId)).id;
    await snapshot(ids.empty, []);
    ids.live = (await machine(NAMES.live, personId, true)).id;
    await snapshot(ids.live, disk, "manual");
  } finally {
    await client.end();
  }
});

/** Deletes exactly what this spec made, in FK order — same rule the shared teardown
 * follows, never a blanket sweep that a concurrent run's rows would fall into. */
test.afterAll(async () => {
  const { client, db } = connect();
  try {
    await db.delete(schema.snapshots).where(eq(schema.snapshots.orgId, orgId));
    await db.delete(schema.machines).where(eq(schema.machines.orgId, orgId));
    if (authUserId) await db.delete(schema.authUser).where(eq(schema.authUser.id, authUserId));
    if (personId) await db.delete(schema.people).where(eq(schema.people.id, personId));
    if (orgId) await db.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
  } finally {
    await client.end();
  }
});

test.beforeEach(async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/");
});

/** The snapshot row on a machine's own Snapshots tab, located by its trigger badge.
 * Each seeded machine has exactly one snapshot, so the badge identifies it uniquely. */
const snapshotRow = async (
  page: import("@playwright/test").Page,
  machineId: string,
  trigger: "Archive" | "Manual" = "Archive",
) => {
  await page.goto(`/machines/${machineId}`);
  await page.getByRole("tab", { name: "Snapshots" }).click();
  return page.getByRole("row").filter({ hasText: trigger });
};

test("the owner can browse their own archived machine's files", async ({ page }) => {
  test.skip(!hasImage, "needs FAKE_SNAPSHOT_IMAGE_PATH on the control plane");

  const row = await snapshotRow(page, ids.owned);
  await row.getByRole("button", { name: "Browse files" }).click();

  await expect(page).toHaveURL(/\/inspections\//);
  // The page says what it is showing, rather than leaving /etc to be discovered missing.
  await expect(page.getByText(/persistent disk/)).toBeVisible();
  // Real contents of the checked-in ext4 fixture, read through the whole stack.
  await expect(page.getByText("notes.txt").first()).toBeVisible();
});

test("nothing can be changed from a snapshot", async ({ page }) => {
  test.skip(!hasImage, "needs FAKE_SNAPSHOT_IMAGE_PATH on the control plane");

  const row = await snapshotRow(page, ids.owned);
  await row.getByRole("button", { name: "Browse files" }).click();
  await expect(page).toHaveURL(/\/inspections\//);

  // A snapshot has no write path at all on the server, so offering these would be
  // offering something that cannot happen.
  await expect(page.getByRole("button", { name: "New folder" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Upload" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
});

test("a file too large to read inline can still be downloaded", async ({ page }) => {
  test.skip(!hasImage, "needs FAKE_SNAPSHOT_IMAGE_PATH on the control plane");

  // The point of the whole feature: recovering the file someone actually needs back. That
  // file is as likely to be a 40 MiB archive as a text note, and `read` refuses anything
  // over 1 MiB or containing a NUL because it feeds an editor. Without download, neither
  // could be recovered at all.
  const snapshot = await snapshotRow(page, ids.owned);
  await snapshot.getByRole("button", { name: "Browse files" }).click();
  await expect(page).toHaveURL(/\/inspections\//);

  await page.getByRole("tab", { name: "Table" }).click();
  const row = page.getByRole("row").filter({ hasText: "big.bin" });
  const download = page.waitForEvent("download");
  await row.getByRole("button", { name: "Download" }).click();

  const file = await download;
  expect(file.suggestedFilename()).toBe("big.bin");
});

test("an offboarded machine's snapshot is refused, with what to do about it", async ({ page }) => {
  // The case the gate exists for: offboarding cleared the owner, and the live-access gate
  // would read that null owner as "allow anyone in the org".
  const row = await snapshotRow(page, ids.orphaned);
  await row.getByRole("button", { name: "Browse files" }).click();

  await expect(page).not.toHaveURL(/\/inspections\//);
  await expect(page.getByText(/Request elevated access/)).toBeVisible();
});

test("a snapshot that captured nothing greys the action out rather than hiding it", async ({
  page,
}) => {
  const row = await snapshotRow(page, ids.empty);
  const button = row.getByRole("button", { name: "Browse files" });
  await expect(button).toBeVisible();
  await expect(button).toBeDisabled();
});

test("a manual snapshot is browsable from the machine's own Snapshots tab", async ({ page }) => {
  test.skip(!hasImage, "needs FAKE_SNAPSHOT_IMAGE_PATH on the control plane");

  // A manual snapshot of a RUNNING machine — a row the Archive page never listed even
  // when it had actions, because it only ever showed one archive-trigger snapshot per
  // archived machine.
  const row = await snapshotRow(page, ids.live, "Manual");
  await row.getByRole("button", { name: "Browse files" }).click();

  await expect(page).toHaveURL(/\/inspections\//);
  // Real contents of the checked-in ext4 fixture, same as the archived-machine path --
  // proving the tab's button reaches the same reader, not just the same route.
  await expect(page.getByText("notes.txt").first()).toBeVisible();
});

test("the Archive page is an overview and offers no actions", async ({ page }) => {
  // It governs nothing now: no Browse files, no legal hold, no row menu. Both of those
  // moved to a machine's Snapshots tab, which lists every snapshot rather than only the
  // one archiving took -- a manual or upgrade snapshot is retained and billed the same
  // way and could never be held from here.
  await page.goto("/archive");
  await expect(page.getByRole("heading", { name: "Archive" })).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: NAMES.owned });
  await expect(row).toBeVisible();

  await expect(row.getByRole("button", { name: "Snapshot actions" })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Browse files" })).toHaveCount(0);
  await expect(row.getByRole("button", { name: /legal hold/i })).toHaveCount(0);
  // Still an overview: the retention clock and the hold state are readable here.
  await expect(row.getByText(/days left/)).toBeVisible();
  await expect(row.getByText("Not held")).toBeVisible();
});

test("legal hold can be placed from a machine's Snapshots tab", async ({ page }) => {
  const row = await snapshotRow(page, ids.owned);
  await row.getByRole("button", { name: "Place legal hold" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});
