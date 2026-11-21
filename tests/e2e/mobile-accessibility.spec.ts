import { execSync } from "node:child_process";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { DEMO_IDS, demoEvents, demoUsers } from "../../scripts/seed/fixtures";

/**
 * Phone-size usability and accessibility checks (XRPL-051) for the four screens people use at an
 * event: seller event creation, buyer checkout, My Tickets and the door scanner.
 *
 * Every flow runs at three common phone sizes with touch input (taps only, so nothing can depend on
 * hover). At each step the page must not scroll sideways, must pass the axe rules for WCAG 2.2 A and
 * AA (labels, names, contrast, target size), and where checked, every keyboard stop must show a
 * focus ring. Wallet steps are not covered: they need a person approving in Xaman. The scanner's
 * two API calls are answered by the test, because a real check-in needs a ticket on the ledger.
 */

const PHONES = [
  { name: "small Android phone (360 x 640)", width: 360, height: 640 },
  { name: "iPhone (390 x 844)", width: 390, height: 844 },
  { name: "large Android phone (412 x 915)", width: 412, height: 915 },
] as const;

const name = (id: string) => demoUsers.find((u) => u.id === id)?.displayName as string;
const ARTIST = name(DEMO_IDS.users.artistSeller);
const CUSTOMER = name(DEMO_IDS.users.customer);
const HEADLINE_ID = DEMO_IDS.events.headlineShow;
const HEADLINE = demoEvents.find((e) => e.id === HEADLINE_ID)?.title as string;
const HOLDER_WALLET = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";

test.beforeAll(() => {
  const url = process.env.TEST_DATABASE_URL ?? "";
  // A listed ticket for the checkout, and a checked-in one so the organiser's chart has data.
  execSync("npx tsx tests/e2e/ticket-fixtures.ts", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url },
  });
});

/**
 * The page fits the screen: nothing is wider than the phone. Measured against the phone's own
 * width, not `window.innerWidth`: a phone browser quietly widens its viewport to fit oversized
 * content, so the two would always agree.
 */
async function expectNoSidewaysScroll(page: Page, where: string): Promise<void> {
  const screen = page.viewportSize()?.width ?? 0;
  const measured = await page.evaluate((screenWidth) => {
    const tooWide = [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((el) => {
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.right > screenWidth + 1;
      })
      .slice(0, 4)
      .map((el) => `<${el.tagName.toLowerCase()} class="${el.className}">`.slice(0, 110));
    return { page: document.documentElement.scrollWidth, tooWide };
  }, screen);
  // Soft, like the other checks: one run then reports every problem on every screen.
  expect
    .soft(measured.page, `${where} scrolls sideways. Too wide: ${measured.tooWide.join(" ")}`)
    .toBeLessThanOrEqual(screen + 1);
}

/** No axe violations of WCAG 2.2 A or AA: labels and names, contrast, target size, ARIA use. */
async function expectAccessible(page: Page, where: string): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    // Next.js's own development overlay, present only under `next dev`.
    .exclude("nextjs-portal")
    .analyze();
  const found = violations.map(
    (v) => `${v.id}: ${v.help} at ${v.nodes.slice(0, 3).map((node) => node.target.join(" ")).join(" | ")}`,
  );
  expect.soft(found, `${where} has accessibility problems`).toEqual([]);
}

async function audit(page: Page, where: string): Promise<void> {
  // Some sections stream in after the first paint: check the finished page, not its placeholder.
  await page.waitForLoadState("networkidle");
  await expectNoSidewaysScroll(page, where);
  await expectAccessible(page, where);
}

/**
 * Tabs through the page from the top: every stop must be on screen and show a focus ring, on
 * itself or on the card that contains it (a card that is one big link draws the ring itself).
 * A ring with three or four of its sides cut off by an `overflow: hidden` parent does not count:
 * what is left is a stray line, not a ring.
 */
async function expectVisibleFocus(page: Page, where: string, stops = 10): Promise<void> {
  for (let stop = 0; stop < stops; stop += 1) {
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      // Next.js's development overlay takes a tab stop under `next dev` only.
      if (!el || el === document.body || el.tagName.toLowerCase() === "nextjs-portal") return null;
      const ringed = (node: Element | null): boolean => {
        if (!node) return false;
        const style = getComputedStyle(node);
        if (style.boxShadow !== "none") return true;
        const width = parseFloat(style.outlineWidth);
        if (style.outlineStyle === "none" || !(width > 0)) return false;
        // The outline sits outside the element. How many of its sides does a clipping parent cut off?
        const reach = width + Math.max(0, parseFloat(style.outlineOffset) || 0);
        const box = node.getBoundingClientRect();
        const cut = { left: false, right: false, top: false, bottom: false };
        for (let parent = node.parentElement; parent; parent = parent.parentElement) {
          const clip = getComputedStyle(parent);
          if (clip.overflowX === "visible" && clip.overflowY === "visible") continue;
          const frame = parent.getBoundingClientRect();
          cut.left ||= box.left - reach < frame.left;
          cut.right ||= box.right + reach > frame.right;
          cut.top ||= box.top - reach < frame.top;
          cut.bottom ||= box.bottom + reach > frame.bottom;
        }
        return Object.values(cut).filter(Boolean).length < 3;
      };
      const box = el.getBoundingClientRect();
      return {
        label: (el.getAttribute("aria-label") ?? el.textContent ?? el.getAttribute("name") ?? "").trim().slice(0, 50),
        tag: el.tagName.toLowerCase(),
        ring: ringed(el) || ringed(el.closest("article")),
        onScreen: box.width > 0 && box.height > 0,
      };
    });
    if (!focused) return; // Focus left the page.
    expect
      .soft(focused.ring && focused.onScreen, `${where}: <${focused.tag}> "${focused.label}" shows no focus ring`)
      .toBe(true);
  }
}

async function signInAs(page: Page, displayName: string): Promise<void> {
  await page.goto("/onboarding");
  await page.getByRole("button", { name: `Continue as ${displayName}` }).tap();
  // On a phone the header has no room for the account name, so wait for the move away instead.
  await page.waitForURL((url) => !url.pathname.startsWith("/onboarding"));
}

for (const phone of PHONES) {
  test.describe(`on a ${phone.name}`, () => {
    test.use({ viewport: { width: phone.width, height: phone.height }, isMobile: true, hasTouch: true });

    test("a seller creates, prices and publishes an event by touch", async ({ page }) => {
      const eventTitle = `Phone check ${phone.width} ${Date.now()}`;
      await signInAs(page, ARTIST);

      await page.goto("/seller/events/new");
      await audit(page, "New event form");
      await expectVisibleFocus(page, "New event form", 8);

      await page.getByLabel("Event name").fill(eventTitle);
      await page.getByLabel("Starts").fill("2027-09-01T20:00");
      await page.getByLabel("Venue").fill("Phone Check Hall");
      await page.getByLabel("City").fill("Galway");
      await page.getByRole("button", { name: "Save draft" }).tap();

      await page.waitForURL("**/seller/events");
      await audit(page, "Seller's event list");
      await page.getByRole("link", { name: eventTitle }).tap();

      await page.getByLabel("Tier name").fill("General Admission");
      await page.getByLabel("Price in XRP").fill("2");
      await page.getByLabel("Quantity").fill("5");
      await page.getByRole("button", { name: "Add tier" }).tap();
      await expect(page.getByRole("heading", { name: "General Admission", level: 4 })).toBeVisible();
      await audit(page, "Event editor with a tier");

      await page.getByRole("button", { name: "Publish event" }).tap();
      await expect(page.getByText("Published", { exact: true }).first()).toBeVisible();
      await audit(page, "Published event editor");
    });

    test("the event form says what is wrong with a field, in words", async ({ page }) => {
      await signInAs(page, ARTIST);
      await page.goto("/seller/events/new");

      await page.getByLabel("Event name").fill("Ends before it starts");
      await page.getByLabel("Starts").fill("2027-09-01T20:00");
      await page.getByLabel("Ends").fill("2027-09-01T19:00");
      await page.getByLabel("Venue").fill("Phone Check Hall");
      await page.getByLabel("City").fill("Galway");
      await page.getByRole("button", { name: "Save draft" }).tap();

      // The message is visible text tied to its field, not a colour change alone.
      const ends = page.getByLabel("Ends");
      await expect(ends).toHaveAttribute("aria-invalid", "true");
      await expect(ends).toHaveAccessibleDescription("End time must be after the start time");
      await expect(page.getByText("End time must be after the start time")).toBeVisible();
      await audit(page, "New event form with an error");
    });

    test("a buyer picks a ticket and reaches the wallet step", async ({ page }) => {
      await signInAs(page, CUSTOMER);

      await page.goto(`/events/${HEADLINE_ID}`);
      await expect(page.getByRole("heading", { name: HEADLINE, level: 1 })).toBeVisible();
      await audit(page, "Event page");
      await expectVisibleFocus(page, "Event page");

      await page.getByRole("link", { name: "Buy ticket" }).first().tap();
      await page.waitForURL("**/purchase?tier=*");
      await expect(page.getByRole("heading", { name: "Buy a ticket" })).toBeVisible();
      // The order is reviewable before any wallet step: what, where and how much.
      await expect(page.getByText("serial #1")).toBeVisible();
      await expect(page.getByText("Ticket price")).toBeVisible();
      await audit(page, "Checkout");

      // This account has no wallet yet, so the next step is to connect one.
      await page.getByRole("main").getByRole("link", { name: "Connect your wallet" }).tap();
      await page.waitForURL("**/connect");
      await audit(page, "Connect wallet");
    });

    test("My Tickets says what to do without a session or a wallet", async ({ page }) => {
      await page.goto("/tickets");
      await expect(page.getByText("Sign in to see your tickets")).toBeVisible();
      await audit(page, "My Tickets, signed out");

      await signInAs(page, CUSTOMER);
      await page.goto("/tickets");
      await expect(page.getByText("Tickets are NFTs held by your wallet")).toBeVisible();
      await audit(page, "My Tickets, no wallet");
      await page.getByRole("main").getByRole("link", { name: "Connect your wallet" }).tap();
      await page.waitForURL("**/connect");
    });

    test("an organiser checks a ticket in at the door", async ({ page }) => {
      let verifyAnswer: "VERIFIED" | "ALREADY_USED" = "VERIFIED";
      await page.route("**/api/checkin/verify", (route) =>
        verifyAnswer === "VERIFIED"
          ? route.fulfill({
              json: {
                data: {
                  status: "VERIFIED",
                  challengeId: "5eed0000-0000-4000-8000-000000000911",
                  ticketId: "5eed0000-0000-4000-8000-000000000901",
                  eventId: HEADLINE_ID,
                  nftokenId: `00080000${"A1".repeat(28)}`,
                  ownerAddress: HOLDER_WALLET,
                  ledgerIndex: 1234567,
                },
              },
            })
          : route.fulfill({
              status: 409,
              json: { error: { code: "ALREADY_USED", message: "This ticket has already been used." } },
            }),
      );
      await page.route("**/api/checkin/confirm", (route) =>
        route.fulfill({
          json: {
            data: {
              status: "ADMITTED",
              ticketId: "5eed0000-0000-4000-8000-000000000901",
              eventId: HEADLINE_ID,
              checkedInAt: "2027-03-12T19:30:00.000Z",
              ledgerIndex: 1234567,
            },
          },
        }),
      );

      await signInAs(page, ARTIST);
      await page.goto(`/organiser/events/${HEADLINE_ID}/checkin`);
      await expect(page.getByRole("heading", { name: "Scan a ticket" })).toBeVisible();
      await audit(page, "Scanner, ready");
      await expectVisibleFocus(page, "Scanner, ready");

      await page.getByLabel("Ticket code").fill("xrplt:1:phone-check");
      await page.getByRole("button", { name: "Check ticket" }).tap();
      await expect(page.getByText("Valid ticket")).toBeVisible();
      await audit(page, "Scanner, valid ticket");

      await page.getByRole("button", { name: "Admit" }).tap();
      await expect(page.getByText("Admitted", { exact: true })).toBeVisible();
      await audit(page, "Scanner, admitted");

      // A second scan of the same ticket is refused in words, with the next action.
      verifyAnswer = "ALREADY_USED";
      await page.getByRole("button", { name: "Scan next ticket" }).tap();
      await page.getByLabel("Ticket code").fill("xrplt:1:phone-check");
      await page.getByRole("button", { name: "Check ticket" }).tap();
      const refused = page.getByRole("alert").filter({ hasText: "Already checked in" });
      await expect(refused).toContainText("Do not admit");
      await audit(page, "Scanner, already used");
      await refused.getByRole("button", { name: "Scan next ticket" }).tap();
      await expect(page.getByLabel("Ticket code")).toBeFocused();
    });

    test("the screens around those flows fit a phone too", async ({ page }) => {
      const sweep = async (paths: string[]) => {
        for (const path of paths) {
          const response = await page.goto(path);
          expect(response?.status(), `${path} loads`).toBe(200);
          await audit(page, path);
        }
      };

      // A visitor browsing before signing in.
      await sweep(["/", "/search", "/resale", "/onboarding", `/sellers/${DEMO_IDS.users.artistSeller}`]);
      // Event cards are one big link each: the card must still show where keyboard focus is.
      await page.goto("/", { waitUntil: "networkidle" });
      await expectVisibleFocus(page, "Discover", 12);

      await signInAs(page, CUSTOMER);
      await sweep(["/profile", "/wishlist", "/following", "/friends", "/preferences", "/privacy"]);

      await signInAs(page, ARTIST);
      await sweep([
        "/seller/events",
        "/seller/profile",
        `/seller/events/${HEADLINE_ID}`,
        `/organiser/events/${HEADLINE_ID}/inventory`,
        `/organiser/events/${HEADLINE_ID}/analytics`,
      ]);
    });

    test("the browser's own controls are drawn for the page's colours", async ({ page }) => {
      // A phone set to light mode must not draw dark-on-dark date pickers and menus on this dark page.
      await page.emulateMedia({ colorScheme: "light" });
      await page.goto("/onboarding");
      const colours = await page.evaluate(() => {
        const [r = 0, g = 0, b = 0] = (getComputedStyle(document.body).backgroundColor.match(/d+/g) ?? []).map(Number);
        return {
          pageIsDark: (r * 299 + g * 587 + b * 114) / 1000 < 128,
          declared: getComputedStyle(document.documentElement).colorScheme,
        };
      });
      expect(colours.declared).toBe(colours.pageIsDark ? "dark" : "light");
    });

    test("the main menu works by touch and by keyboard", async ({ page }) => {
      await signInAs(page, CUSTOMER);
      await page.goto("/");

      const toggle = page.getByRole("button", { name: "Open main menu" });
      await toggle.tap();
      const menu = page.getByRole("navigation", { name: "Menu" });
      await expect(menu.getByRole("link", { name: "My tickets" })).toBeVisible();
      await audit(page, "Main menu, open");
      await menu.getByRole("link", { name: "My tickets" }).tap();
      await page.waitForURL("**/tickets");
      await expect(menu).toBeHidden();

      // Keyboard: Enter opens it, Escape closes it and puts focus back on the button.
      await page.getByRole("button", { name: "Open main menu" }).focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("navigation", { name: "Menu" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("navigation", { name: "Menu" })).toBeHidden();
      await expect(page.getByRole("button", { name: "Open main menu" })).toBeFocused();
    });
  });
}
