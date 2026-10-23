import { test, expect } from "@playwright/test";

test("web page has correct bottom icons text", async ({ page }) => {
  await page.goto("/");

  const expectedTexts = ["Proper Cache", "Tree shaking", "No useless runs"];

  for (const text of expectedTexts) {
    await expect(page.getByText(text, { exact: true })).toBeVisible();
  }
});

test("calculator hydrates and updates the used utility result", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByText("62", { exact: true })).toBeVisible();
  await page.getByRole("slider").focus();
  await page.getByRole("slider").press("ArrowRight");
  await expect(page.getByText("63", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("demo navigation and API request use the packaged application", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "View Demo" }).click();
  await expect(page.getByRole("heading", { name: "Bóbr Demo" })).toBeVisible();
  await page.getByRole("button", { name: "Call API" }).click();
  await expect(page.getByText("hello web", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Back to Home" }).click();
  await expect(page.getByRole("slider")).toBeVisible();
});

test("API and missing routes return the expected status", async ({
  request,
}) => {
  const api = await request.get("/api/hello");
  expect(api.status()).toBe(200);
  expect(await api.text()).toBe("hello web");
  expect((await request.get("/this-route-does-not-exist")).status()).toBe(404);
});
