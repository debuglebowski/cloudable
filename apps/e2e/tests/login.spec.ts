import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { E2E_USER_FILE, type E2eUser } from "../setup/global-setup";

let user: E2eUser;

test.beforeAll(async () => {
  user = JSON.parse(await readFile(E2E_USER_FILE, "utf8")) as E2eUser;
});

test("signs in with a real BetterAuth login and loads its own org's Machines page", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  // root.tsx's session guard: an authenticated visit lands on "/", never back on /login.
  await expect(page).toHaveURL("/");

  // Scoped to the sidebar nav: the dashboard's own "Machines" stat card is
  // also a link with the same accessible name.
  await page.getByRole("navigation").getByRole("link", { name: "Machines" }).click();
  await expect(page).toHaveURL("/machines");
  await expect(page.getByRole("heading", { name: "Machines" })).toBeVisible();

  // The point of this assertion: it proves `CurrentUserAuthentication`
  // resolved this login's session to its own real `people` row and
  // org-scoped query (http/middleware/auth.ts) rather than 401/500ing —
  // the exact class of bug a CORS/cookie misconfiguration produces (see
  // c8b6ee5). The freshly-created e2e org owns zero machines, so the
  // real "No machines to show." empty state, not the page's error state,
  // is success.
  await expect(page.getByText("Failed to load machines")).not.toBeVisible();
  await expect(page.getByText("No machines to show.")).toBeVisible();
});
