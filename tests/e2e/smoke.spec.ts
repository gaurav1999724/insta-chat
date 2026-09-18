import { expect, test } from "@playwright/test";

// These two pages render for a signed-out visitor with no database query
// that can fail — the only pages this dev environment (no reachable
// Postgres, see PROJECT_ANALYSIS.md §10) can exercise against a real
// running app today. Run with: `npm run dev`, then `npm run test:e2e` in
// another terminal.

test("landing page renders and links to sign-in when signed out", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "InstaMate AI" })).toBeVisible();
  const signInLink = page.getByRole("link", { name: "Sign in" });
  await expect(signInLink).toBeVisible();

  await signInLink.click();
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("sign-in page renders the magic-link form", async ({ page }) => {
  await page.goto("/sign-in");

  // Note: shadcn's `CardTitle` here renders a plain <div>, not a semantic
  // heading element, so it carries no ARIA `heading` role — hence
  // `getByText` rather than `getByRole("heading", ...)` (used for the "/"
  // page's actual <h1> above). This is a pre-existing accessibility gap in
  // the shared Card component, not something to silently patch here.
  await expect(page.getByText("Sign in to InstaMate AI")).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send sign-in link" })).toBeVisible();
});

test("visiting an authenticated route while signed out redirects to sign-in", async ({
  page,
}) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/sign-in$/);
});
