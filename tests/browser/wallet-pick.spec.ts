// "Use a connected wallet" under the withdraw destination and the pay refund address.
import { expect, test, type Page } from "@playwright/test";
import { getAddress } from "viem";
import { pickToken } from "./helpers/combobox.ts";

const SESSION = "0xabcdef0123456789abcdef0123456789abcdef01";
const W1 = "0x1111111111111111111111111111111111111aaa";
const W2 = "0x2222222222222222222222222222222222222bbb";
const W3 = "0x3333333333333333333333333333333333333ccc";
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const ARB = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
const SOL = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
const TOKENS = [
  { assetId: USDC, symbol: "USDC", blockchain: "near", decimals: 6 },
  { assetId: ARB, symbol: "USDC", blockchain: "arb", decimals: 6 },
  { assetId: SOL, symbol: "USDC", blockchain: "sol", decimals: 6 },
];
const DEP = "a".repeat(64);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** window.ethereum with two accounts already exposed; eth_requestAccounts adds a third. */
async function mockEthereum(page: Page) {
  await page.addInitScript(
    ([w1, w2, w3]) => {
      const log: string[] = [];
      (window as unknown as { __eth: string[] }).__eth = log;
      (window as unknown as { ethereum: unknown }).ethereum = {
        async request({ method }: { method: string }) {
          log.push(method);
          if (method === "eth_accounts") return [w1, w2];
          if (method === "eth_requestAccounts") return [w3];
          throw new Error("unsupported " + method);
        },
      };
    },
    [W1, W2, W3],
  );
}

async function setupWithdraw(page: Page) {
  const calls: { path: string; body: unknown }[] = [];
  await page.route(/^(?!http:\/\/(127\.0\.0\.1|localhost)[:/]).*/, (r) => r.abort());
  await page.route("**/api/**", (r) => {
    const req = r.request();
    const path = new URL(req.url()).pathname;
    const body = req.postData() ? JSON.parse(req.postData()!) : null;
    calls.push({ path, body });
    if (path === "/api/me") return r.fulfill({ json: { account: SESSION, kind: "evm" } });
    if (path === "/api/balances")
      return r.fulfill({ json: [{ tokenId: USDC, symbol: "USDC", blockchain: "near", decimals: 6, amount: "2500000", formatted: "2.5" }] });
    if (path === "/api/tokens") return r.fulfill({ json: TOKENS });
    if (path === "/api/withdrawals" && req.method() === "GET") return r.fulfill({ json: [] });
    if (path === "/api/withdrawals/quote")
      return r.fulfill({
        status: 201,
        json: {
          depositAddress: DEP, deadline: "2999-01-01T00:00:00.000Z", intent: { standard: "erc191", payload: "{}" },
          withdrawal: {
            depositAddress: DEP, originSymbol: "USDC", amountFormatted: "1", destinationSymbol: "USDC", destinationBlockchain: "arb", recipient: body.recipient,
            amountOutFormatted: "0.99", minAmountOutFormatted: "0.98", status: "AWAITING_SIGNATURE", destinationTxHashes: [], deadline: "2999-01-01T00:00:00.000Z",
            expired: false, createdAt: "2030-01-01T00:00:00.000Z",
          },
        },
      });
    return r.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await mockEthereum(page);
  return calls;
}

test("withdraw: connected EVM wallets fill the destination, review and confirmation still required", async ({ page }) => {
  const calls = await setupWithdraw(page);
  await page.goto("/#/withdraw");
  await expect(page.getByRole("heading", { name: "Withdraw" })).toBeVisible();
  // No destination chosen yet: nothing to offer.
  await expect(page.locator(".wallet-chip")).toHaveCount(0);

  await pickToken(page, "wd-dest", "arb", "USDC, Arbitrum");
  const row = page.getByRole("group", { name: "Use a connected wallet" });
  await expect(row.locator(".wallet-chip")).toHaveCount(3);
  const chip1 = row.getByRole("button", { name: `Use Browser wallet 1: ${getAddress(W1)}` });
  await expect(chip1).toHaveAttribute("title", getAddress(W1));
  await expect(chip1).toContainText(short(getAddress(W1)));
  await expect(row.getByRole("button", { name: `Use Signed-in account: ${getAddress(SESSION)}` })).toBeVisible();
  await expect(row.getByRole("button", { name: `Use Browser wallet 2: ${getAddress(W2)}` })).toBeVisible();
  // Nothing is filled until a click; listing used eth_accounts only, never a popup.
  await expect(page.locator("#wd-recipient")).toHaveValue("");
  expect(await page.evaluate(() => (window as unknown as { __eth: string[] }).__eth)).not.toContain("eth_requestAccounts");

  const box = await chip1.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);

  await chip1.click();
  await expect(page.locator("#wd-recipient")).toHaveValue(getAddress(W1));
  await expect(page.locator("#wd-recipient")).toBeFocused();
  await expect(page.locator("#wd-recipient")).toBeEditable();
  expect(calls.some((c) => c.path === "/api/withdrawals/quote")).toBe(false);

  await page.locator("#wd-amount").fill("1");
  await page.getByRole("button", { name: "Review withdrawal" }).click();
  expect(calls.find((c) => c.path === "/api/withdrawals/quote")!.body).toMatchObject({ recipient: getAddress(W1), destinationAsset: ARB });
  await expect(page.locator("#wd-address")).toHaveText(getAddress(W1));
  const sign = page.getByRole("button", { name: "Sign in wallet" });
  await expect(sign).toBeDisabled();
  await page.getByLabel("I confirm this address is on Arbitrum (arb)").check();
  await expect(sign).toBeEnabled();
});

test("withdraw: no wallet chips for a Solana destination", async ({ page }) => {
  await setupWithdraw(page);
  await page.goto("/#/withdraw");
  await pickToken(page, "wd-dest", "sol", "USDC, Solana");
  await expect(page.getByLabel("Destination address on Solana (sol)")).toBeVisible();
  await expect(page.locator(".wallet-chip")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Connect/ })).toHaveCount(0);
  await expect(page.getByText("Exchange deposit address or your wallet; check the network matches")).toBeVisible();
});

test("withdraw: Connect another wallet asks the wallet, then lists the new account without filling", async ({ page }) => {
  await setupWithdraw(page);
  await page.goto("/#/withdraw");
  await pickToken(page, "wd-dest", "arb", "USDC, Arbitrum");
  await expect(page.locator(".wallet-chip")).toHaveCount(3);
  await page.getByRole("button", { name: "Connect another wallet" }).click();
  await expect(page.locator(".wallet-chip")).toHaveCount(4);
  await expect(page.getByRole("button", { name: `Use Browser wallet 3: ${getAddress(W3)}` })).toBeVisible();
  await expect(page.locator("#wd-recipient")).toHaveValue("");
});

async function setupPay(page: Page) {
  const seen: { quote?: unknown } = {};
  await page.route(/^(?!http:\/\/(127\.0\.0\.1|localhost)[:/]).*/, (r) => r.abort());
  await page.route("**/api/**", (r) => {
    const req = r.request();
    const path = new URL(req.url()).pathname;
    if (path === "/api/public/invoices/pub1")
      return r.fulfill({
        json: {
          publicId: "pub1", status: "issued", tokenId: USDC, symbol: "USDC", total: "700000", totalFormatted: "0.7", payTo: "alice.near", dueDate: "2030-01-31",
          data: { number: "DEMO-001", client: "Client", issuer: "Studio", dueDate: "2030-01-31", tokenId: USDC, notes: "", items: [{ description: "Design", quantity: "1", unitPrice: "0.7" }] },
        },
      });
    if (path === "/api/tokens") return r.fulfill({ json: TOKENS.filter((t) => t.blockchain !== "near") });
    if (path === "/api/public/invoices/pub1/status") return r.fulfill({ json: { invoiceStatus: "issued", attempts: [] } });
    if (path.endsWith("/quote")) {
      seen.quote = JSON.parse(req.postData()!);
      return r.fulfill({
        status: 201,
        json: { symbol: "USDC", blockchain: "arb", depositAddress: "0xDEPOSIT", originAsset: ARB, amountIn: "710180", amountInFormatted: "0.71018", deadline: new Date(Date.now() + 25 * 60_000).toISOString(), status: "PENDING_DEPOSIT", expired: false },
      });
    }
    if (path === "/api/me") return r.fulfill({ status: 401, json: { error: "Sign in" } });
    return r.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await mockEthereum(page);
  return seen;
}

test("pay: connected EVM wallets fill the refund address; submitting is still the payer's click", async ({ page }) => {
  const seen = await setupPay(page);
  await page.goto("/#/pay/pub1");
  await expect(page.getByRole("heading", { name: "Pay 0.7 USDC" })).toBeVisible();
  await pickToken(page, "pay-token", "arb", "USDC, Arbitrum");
  const row = page.getByRole("group", { name: "Use a connected wallet" });
  // Public page, not signed in: only the browser wallet's accounts.
  await expect(row.locator(".wallet-chip")).toHaveCount(2);
  await expect(page.locator("#pay-refund")).toHaveValue("");
  await row.getByRole("button", { name: `Use Browser wallet 2: ${getAddress(W2)}` }).click();
  await expect(page.getByLabel("Refund address on arb")).toHaveValue(getAddress(W2));
  await expect(page.locator("#pay-refund")).toBeEditable();
  expect(seen.quote).toBeUndefined();
  await page.getByRole("button", { name: "Get payment instructions" }).click();
  await expect(page.locator("#pay-address")).toHaveText("0xDEPOSIT");
  expect(seen.quote).toEqual({ originAsset: ARB, refundTo: getAddress(W2) });
});

test("pay: no wallet chips for a Solana refund address", async ({ page }) => {
  await setupPay(page);
  await page.goto("/#/pay/pub1");
  await pickToken(page, "pay-token", "sol", "USDC, Solana");
  await expect(page.getByLabel("Refund address on sol")).toBeVisible();
  await expect(page.locator(".wallet-chip")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Connect/ })).toHaveCount(0);
});
