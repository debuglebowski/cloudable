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
let liveMachineId = "";

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
    await snapshot((await machine(NAMES.owned, personId)).id, disk);
    await snapshot((await machine(NAMES.orphaned, null)).id, disk);
    await snapshot((await machine(NAMES.empty, personId)).id, []);
    liveMachineId = (await machine(NAMES.live, personId, true)).id;
    await snapshot(liveMachineId, disk, "manual");
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

const openMenuFor = async (page: import("@playwright/test").Page, machineName: string) => {
  await page.goto("/archive");
  await expect(page.getByRole("heading", { name: "Archive" })).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: machineName });
  await row.getByRole("button", { name: "Snapshot actions" }).click();
};

test("the owner can browse their own archived machine's files", async ({ page }) => {
  test.skip(!hasImage, "needs FAKE_SNAPSHOT_IMAGE_PATH on the control plane");

  await openMenuFor(page, NAMES.owned);
  await page.getByRole("menuitem", { name: "Browse files" }).click();

  await expect(page).toHaveURL(/\/archive\/inspections\//);
  // The page says what it is showing, rather than leaving /etc to be discovered missing.
  await expect(page.getByText(/persistent disk/)).toBeVisible();
  // Real contents of the checked-in ext4 fixture, read through the whole stack.
  await expect(page.getByText("notes.txt").first()).toBeVisible();
});

test("nothing can be changed from a snapshot", async ({ page }) => {
  test.skip(!hasImage, "needs FAKE_SNAPSHOT_IMAGE_PATH on the control plane");

  await openMenuFor(page, NAMES.owned);
  await page.getByRole("menuitem", { name: "Browse files" }).click();
  await expect(page).toHaveURL(/\/archive\/inspections\//);

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
  await openMenuFor(page, NAMES.owned);
  await page.getByRole("menuitem", { name: "Browse files" }).click();
  await expect(page).toHaveURL(/\/archive\/inspections\//);

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
  await openMenuFor(page, NAMES.orphaned);
  await page.getByRole("menuitem", { name: "Browse files" }).click();

  await expect(page).not.toHaveURL(/\/archive\/inspections\//);
  await expect(page.getByText(/Request elevated access/)).toBeVisible();
});

test("a snapshot that captured nothing greys the action out rather than hiding it", async ({
  page,
}) => {
  await openMenuFor(page, NAMES.empty);
  const item = page.getByRole("menuitem", { name: "Browse files" });
  await expect(item).toBeVisible();
  await expect(item).toBeDisabled();
});

test("a manual snapshot is browsable from the machine's own Snapshots tab", async ({ page }) => {
  test.skip(!hasImage, "needs FAKE_SNAPSHOT_IMAGE_PATH on the control plane");

  // The Archive page cannot reach this row: it lists archived machines and picks each
  // one's archive-trigger snapshot, and this is a manual snapshot of a RUNNING machine.
  // Before the tab had its own button, a snapshot someone took on purpose could be
  // restored from the console but never opened.
  await page.goto(`/machines/${liveMachineId}`);
  await page.getByRole("tab", { name: "Snapshots" }).click();

  const row = page.getByRole("row").filter({ hasText: "Manual" });
  await row.getByRole("button", { name: "Browse files" }).click();

  await expect(page).toHaveURL(/\/archive\/inspections\//);
  // Real contents of the checked-in ext4 fixture, same as the archived-machine path --
  // proving the tab's button reaches the same reader, not just the same route.
  await expect(page.getByText("notes.txt").first()).toBeVisible();
});
