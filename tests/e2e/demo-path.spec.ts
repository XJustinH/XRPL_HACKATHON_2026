import { expect, test, type Page } from "@playwright/test";
import { DEMO_IDS, demoEvents, demoUsers } from "../../scripts/seed/fixtures";

/**
 * Smoke tests of the demo's click path in a real browser, against a production build with the
 * demo seed. They cover what works without a wallet; wallet steps need a person approving in Xaman.
 * Elements are found by their accessible names (labels, roles, headings), not by styling.
 */

const name = (id: string) => demoUsers.find((u) => u.id === id)?.displayName as string;
const title = (id: string) => demoEvents.find((e) => e.id === id)?.title as string;

const ARTIST = name(DEMO_IDS.users.artistSeller);
const CUSTOMER = name(DEMO_IDS.users.customer);
const HEADLINE = title(DEMO_IDS.events.headlineShow);
const OPEN_MIC = title(DEMO_IDS.events.openMicNight);
const DRAFT = title(DEMO_IDS.events.corkDraft);

/** Creates a draft event as the signed-in seller, adds one tier, and leaves the browser on its page. */
async function createEventWithTier(page: Page, eventTitle: string): Promise<void> {
  await page.goto("/seller/events/new");
  await page.getByLabel("Event name").fill(eventTitle);
  await page.getByLabel("Starts").fill("2027-09-01T20:00");
  await page.getByLabel("Venue").fill("Smoke Test Hall");
  await page.getByLabel("City").fill("Galway");
  await page.getByRole("button", { name: "Save draft" }).click();

  await page.waitForURL("**/seller/events");
  await page.getByRole("link", { name: eventTitle }).click();

  await page.getByLabel("Tier name").fill("General Admission");
  await page.getByLabel("Price in XRP").fill("2");
  await page.getByLabel("Quantity").fill("5");
  await page.getByRole("button", { name: "Add tier" }).click();
  await expect(page.getByRole("heading", { name: "General Admission", level: 4 })).toBeVisible();
}

async function signInAs(page: Page, displayName: string): Promise<void> {
  await page.goto("/onboarding");
  await page.getByRole("button", { name: `Continue as ${displayName}` }).click();
  // Signing in moves to the account's home page, and the header then links to the account by name.
  await expect(page.getByRole("banner").getByRole("link", { name: displayName })).toBeVisible();
}

test("a visitor sees the published demo events but not drafts", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Discover events" })).toBeVisible();
  await expect(page.getByText(HEADLINE)).toBeVisible();
  await expect(page.getByText(OPEN_MIC)).toBeVisible();
  await expect(page.getByText(DRAFT)).toHaveCount(0);
});

test("a customer account can't create events", async ({ page }) => {
  await signInAs(page, CUSTOMER);
  await page.goto("/seller/events/new");

  await expect(page.getByText("Your account can't create events")).toBeVisible();
});

test("a seller creates, prices and publishes an event, and visitors can then find it", async ({ page }) => {
  const eventTitle = `Smoke test gig ${Date.now()}`;
  await signInAs(page, ARTIST);
  await createEventWithTier(page, eventTitle);

  // Reload first: the publish panel only notices the new tier after a reload (known bug, see the
  // next test). Remove this line once that is fixed.
  await page.reload();
  await page.getByRole("button", { name: "Publish event" }).click();
  await expect(page.getByText("Published", { exact: true }).first()).toBeVisible();

  await page.goto("/");
  await expect(page.getByText(eventTitle)).toBeVisible();
});

test("publishing becomes possible as soon as a tier is added, without a reload", async ({ page }) => {
  // Known bug: PublishPanel (src/features/events/publish-panel.tsx) copies its `event` prop into
  // state once, so after a tier is added it keeps the old "add a ticket tier" blocker and the
  // Publish button stays disabled until the page is reloaded. Playwright reports this test as
  // passing while the bug exists. Once it is fixed the test passes for real and Playwright flags
  // it: delete this test.fail line, and the reload in the test above.
  test.fail(true, "Publish panel ignores tiers added after the page loaded");

  await signInAs(page, ARTIST);
  await createEventWithTier(page, `Publish refresh check ${Date.now()}`);

  await expect(page.getByRole("button", { name: "Publish event" })).toBeEnabled({ timeout: 5_000 });
});

test("a seller's storefront shows their published events only", async ({ page }) => {
  await page.goto(`/sellers/${DEMO_IDS.users.artistSeller}`);

  await expect(page.getByRole("heading", { name: ARTIST, level: 1 })).toBeVisible();
  await expect(page.getByText(HEADLINE)).toBeVisible();
  await expect(page.getByText(DRAFT)).toHaveCount(0);
});
