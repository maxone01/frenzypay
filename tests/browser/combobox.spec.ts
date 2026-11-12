import { expect, test, type Page } from "@playwright/test";

// The token combobox (src/ui/combobox.ts) on the Swap page, with a long token list across chains.
const ADDR = "0xabcdef0123456789abcdef0123456789abcdef01";
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const WNEAR = "nep141:wrap.near";
const ETH = "nep141:eth.omft.near";
const FILLER = Array.from({ length: 150 }, (_, i) => ({
  assetId: `nep141:arb-tk${i}.omft.near`, symbol: `TK${String(i + 1).padStart(3, "0")}`, blockchain: "arb", decimals: 6,
}));
// Destinations exclude the origin (USDC): wNEAR + ETH + 150 filler.
const DEST_TOTAL = 152;

async function setup(page: Page) {
  const calls: { path: string; body: unknown }[] = [];
  await page.route(/^(?!http:\/\/(127\.0\.0\.1|localhost)[:/]).*/, (r) => r.abort());
  await page.route("**/api/**", (r) => {
    const req = r.request();
    const path = new URL(req.url()).pathname;
    calls.push({ path, body: req.postData() ? JSON.parse(req.postData()!) : null });
    if (path === "/api/me") return r.fulfill({ json: { account: ADDR, kind: "evm" } });
    if (path === "/api/balances")
      return r.fulfill({ json: [{ tokenId: USDC, symbol: "USDC", blockchain: "near", decimals: 6, amount: "2500000", formatted: "2.5" }] });
    if (path === "/api/tokens")
      return r.fulfill({
        json: [
          { assetId: USDC, symbol: "USDC", blockchain: "near", decimals: 6 },
          { assetId: WNEAR, symbol: "wNEAR", blockchain: "near", decimals: 24 },
          { assetId: ETH, symbol: "ETH", blockchain: "eth", decimals: 18 },
          ...FILLER,
        ],
      });
    return r.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.goto("/#/swap");
  await expect(page.getByRole("combobox", { name: "Swap to" })).toBeVisible();
  return calls;
}

const dest = (page: Page) => page.getByRole("combobox", { name: "Swap to" });
const rows = (page: Page) => page.locator("#sw-dest-list [role=option]");

test("opens as an ARIA combobox, caps long lists at 100 rows and says so", async ({ page }) => {
  await setup(page);
  const input = dest(page);
  await expect(input).toHaveAttribute("aria-expanded", "false");
  await expect(input).toHaveAttribute("aria-controls", "sw-dest-list");
  await input.click();
  await expect(input).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("listbox", { name: "Swap to" })).toBeVisible();
  await expect(rows(page)).toHaveCount(100);
  await expect(page.locator("[data-cb=sw-dest] .cb-count")).toHaveText(`Showing 100 of ${DEST_TOTAL} matches. Keep typing to narrow the list.`);
  // Mixed chains: every row carries its chain tag, named in the option.
  await expect(page.getByRole("option", { name: "ETH, Ethereum" })).toBeVisible();
  // Rows are tap-sized and the list scrolls inside a bounded popover.
  const h = await rows(page).first().evaluate((el) => el.getBoundingClientRect().height);
  expect(h).toBeGreaterThanOrEqual(44);
  const listH = await page.locator("#sw-dest-list").evaluate((el) => el.getBoundingClientRect().height);
  expect(listH).toBeLessThanOrEqual(322);
});

test("type to filter: exact symbol first, chain codes match, empty state", async ({ page }) => {
  await setup(page);
  await dest(page).fill("eth");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toHaveAccessibleName("ETH, Ethereum");
  await expect(page.locator("[data-cb=sw-dest] .cb-count")).toHaveText(`Showing 1 of ${DEST_TOTAL}`);
  await dest(page).fill("arb");
  await expect(page.locator("[data-cb=sw-dest] .cb-count")).toHaveText("Showing 100 of 150 matches. Keep typing to narrow the list.");
  await dest(page).fill("zzzz");
  await expect(rows(page)).toHaveCount(0);
  await expect(page.locator("[data-cb=sw-dest] .cb-empty")).toHaveText('No token matches "zzzz"');
});

test("keyboard: arrows, Home/End, Enter selects, Escape closes and keeps the choice", async ({ page }) => {
  const calls = await setup(page);
  const input = dest(page);
  await input.focus();
  await page.keyboard.press("ArrowDown");
  await expect(input).toHaveAttribute("aria-expanded", "true");
  await expect(input).toHaveAttribute("aria-activedescendant", "sw-dest-opt-0");
  await page.keyboard.press("ArrowDown");
  await expect(input).toHaveAttribute("aria-activedescendant", "sw-dest-opt-1");
  await page.keyboard.press("End");
  await expect(input).toHaveAttribute("aria-activedescendant", "sw-dest-opt-99");
  await expect(page.locator("#sw-dest-opt-99")).toBeInViewport();
  await page.keyboard.press("Home");
  await expect(input).toHaveAttribute("aria-activedescendant", "sw-dest-opt-0");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  // Second destination row is ETH (list order: wNEAR, ETH, filler).
  await expect(input).toHaveAttribute("aria-expanded", "false");
  await expect(input).toHaveValue("ETH");
  await expect(input).toHaveAttribute("data-value", ETH);
  await expect(input).toBeFocused();
  // The chosen token shows as a chip with its chain tag.
  await expect(page.locator("[data-cb=sw-dest] .cb-field .cb-avatar img")).toHaveAttribute("src", "/img/tokens/eth.svg");
  await expect(page.locator("#sw-dest-chain")).toHaveText("Ethereum");
  // Reopen, type, Escape: the list closes and the committed choice comes back.
  await input.fill("tk00");
  await expect(rows(page)).toHaveCount(9);
  await page.keyboard.press("Escape");
  await expect(input).toHaveAttribute("aria-expanded", "false");
  await expect(input).toHaveValue("ETH");
  await expect(input).toBeFocused();
  // Enter on the closed field submits the form with the chosen token.
  await page.locator("#sw-amount").fill("1");
  await input.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => calls.some((c) => c.path === "/api/swaps/quote")).toBe(true);
  expect(calls.find((c) => c.path === "/api/swaps/quote")!.body).toMatchObject({ destinationAsset: ETH });
});

test("pointer: click a row, click outside closes, clear empties the field", async ({ page }) => {
  await setup(page);
  const input = dest(page);
  await input.click();
  await page.getByRole("option", { name: "wNEAR, NEAR" }).click();
  await expect(input).toHaveValue("wNEAR");
  await expect(page.locator("[data-cb=sw-dest] .cb-field .cb-avatar img")).toHaveAttribute("src", "/img/tokens/near.png");
  await input.click();
  await expect(page.getByRole("option", { name: "wNEAR, NEAR" })).toHaveAttribute("aria-selected", "true");
  // Click the top-left corner: on narrow screens the popover opens upward and covers the heading.
  await page.mouse.click(2, 2);
  await expect(input).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#sw-dest-list")).toBeHidden();
  // Unknown tokens get a letter avatar, not a remote image.
  await input.fill("tk001");
  await page.getByRole("option", { name: "TK001, Arbitrum" }).click();
  await expect(page.locator("[data-cb=sw-dest] .cb-field .cb-avatar")).toHaveText("T");
  await page.getByRole("button", { name: "Clear Swap to" }).click();
  await expect(dest(page)).toHaveValue("");
  await expect(dest(page)).toHaveAttribute("data-value", "");
  await expect(dest(page)).toBeFocused();
  await expect(page.getByRole("button", { name: "Clear Swap to" })).toBeHidden();
});

test("one shared chain: the chain tag is dropped and the balance sits on the right", async ({ page }) => {
  await setup(page);
  const origin = page.getByRole("combobox", { name: "From your balance" });
  // A single balance is preselected and shown as a chip.
  await expect(origin).toHaveValue("USDC");
  await origin.click();
  await expect(page.locator("#sw-origin-list [role=option]")).toHaveCount(1);
  await expect(page.locator("#sw-origin-list .cb-tag")).toHaveCount(0);
  await expect(page.locator("#sw-origin-list .cb-meta")).toHaveText("2.5");
  await expect(page.getByRole("option", { name: "USDC, 2.5" })).toBeVisible();
});

test("390px wide: no horizontal scroll, popover stays on screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await dest(page).click();
  await expect(rows(page)).toHaveCount(100);
  const box = await page.locator("[data-cb=sw-dest] .cb-pop").boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("flips above the field when there is no room below", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 420 });
  await setup(page);
  // The page is shorter than the viewport, so scrolling cannot help: push the field to the bottom edge with a spacer instead.
  await page.evaluate(() => {
    const field = document.querySelector("[data-cb=sw-dest] .cb-field")!;
    const spacer = document.createElement("div");
    spacer.style.height = `${Math.max(0, window.innerHeight - 90 - field.getBoundingClientRect().bottom)}px`;
    field.closest("form")!.before(spacer);
  });
  await dest(page).click();
  const field = await page.locator("[data-cb=sw-dest] .cb-field").boundingBox();
  const pop = await page.locator("[data-cb=sw-dest] .cb-pop").boundingBox();
  expect(pop!.y + pop!.height).toBeLessThanOrEqual(field!.y);
  expect(pop!.y).toBeGreaterThanOrEqual(0);
});

test("reduced motion: the chevron does not animate", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setup(page);
  const d = await page.locator("[data-cb=sw-dest] .cb-chev svg").evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(d).toBe("0s");
});
