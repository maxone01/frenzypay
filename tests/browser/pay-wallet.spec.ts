// One-click "Pay with wallet" on the pay page, against a mocked EIP-1193 window.ethereum and mocked /api.
import { expect, test, type Page } from "@playwright/test";
import { pickToken } from "./helpers/combobox.ts";

const USDC_INV = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const ETH_ARB = "nep141:arb.omft.near";
const USDC_ARB = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
const USDC_ARB_CONTRACT = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const DEPOSIT = "0x2222222222222222222222222222222222222222";
const PAYER = "0x3333333333333333333333333333333333333333";
const REFUND = "0x0000000000000000000000000000000000000001";
const TX = `0x${"ab".repeat(32)}`;
const TOKENS = [
  { assetId: ETH_ARB, symbol: "ETH", blockchain: "arb", decimals: 18 },
  { assetId: USDC_ARB, symbol: "USDC", blockchain: "arb", decimals: 6, contractAddress: USDC_ARB_CONTRACT },
  { assetId: "nep141:sol.omft.near", symbol: "SOL", blockchain: "sol", decimals: 9 },
];
const QUOTES: Record<string, { amountIn: string; amountInFormatted: string; symbol: string; blockchain: string; depositAddress: string }> = {
  [ETH_ARB]: { amountIn: "300000000000000", amountInFormatted: "0.0003", symbol: "ETH", blockchain: "arb", depositAddress: DEPOSIT },
  [USDC_ARB]: { amountIn: "710180", amountInFormatted: "0.71018", symbol: "USDC", blockchain: "arb", depositAddress: DEPOSIT },
  "nep141:sol.omft.near": { amountIn: "5000000", amountInFormatted: "0.005", symbol: "SOL", blockchain: "sol", depositAddress: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T" },
};

async function mockApi(page: Page) {
  const seen: { deposit: unknown[]; quote?: Record<string, unknown> } = { deposit: [] };
  await page.route(/^(?!http:\/\/(127\.0\.0\.1|localhost)[:/]).*/, (r) => r.abort());
  await page.route("**/api/**", async (r) => {
    const req = r.request();
    const path = new URL(req.url()).pathname;
    if (path === "/api/public/invoices/pub1")
      return r.fulfill({
        json: {
          publicId: "pub1", status: "issued", tokenId: USDC_INV, symbol: "USDC", total: "700000", totalFormatted: "0.7", payTo: "alice.near", dueDate: "2030-01-31",
          data: { number: "DEMO-001", client: "Demo Client", issuer: "Example Studio", dueDate: "2030-01-31", tokenId: USDC_INV, notes: "", items: [{ description: "Design", quantity: "1", unitPrice: "0.7" }] },
        },
      });
    if (path === "/api/tokens") return r.fulfill({ json: TOKENS });
    // Like the server: the attempt stays PENDING_DEPOSIT until the chain sees the deposit.
    if (path === "/api/public/invoices/pub1/status") return r.fulfill({ json: { invoiceStatus: "issued", attempts: seen.quote ? [seen.quote] : [] } });
    if (path.endsWith("/quote")) {
      const body = JSON.parse(req.postData()!) as { originAsset: string };
      seen.quote = {
        ...QUOTES[body.originAsset], originAsset: body.originAsset, deadline: new Date(Date.now() + 25 * 60_000).toISOString(), status: "PENDING_DEPOSIT", expired: false,
      };
      return r.fulfill({ status: 201, json: seen.quote });
    }
    if (path.endsWith("/deposit")) {
      seen.deposit.push(JSON.parse(req.postData()!));
      return r.fulfill({ json: { ok: true } });
    }
    return r.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => {} }, configurable: true }));
  return seen;
}

type WalletOpts = { chainId: string; reject?: "switch" | "send"; unknownChain?: boolean };

/** A scripted window.ethereum. Every request is recorded in window.__eth. */
async function installWallet(page: Page, opts: WalletOpts) {
  await page.addInitScript(
    ({ o, payer, tx }) => {
      const calls: { method: string; params?: unknown[] }[] = [];
      let chain = o.chainId;
      let added = false;
      const w = window as unknown as { __eth: typeof calls; ethereum: unknown };
      w.__eth = calls;
      w.ethereum = {
        async request({ method, params }: { method: string; params?: unknown[] }) {
          calls.push({ method, params });
          if (method === "eth_accounts") return [];
          if (method === "eth_requestAccounts") return [payer];
          if (method === "eth_chainId") return chain;
          if (method === "wallet_switchEthereumChain") {
            if (o.reject === "switch") throw Object.assign(new Error("User rejected the request."), { code: 4001 });
            if (o.unknownChain && !added) throw Object.assign(new Error("Unrecognized chain ID"), { code: 4902 });
            chain = (params![0] as { chainId: string }).chainId;
            return null;
          }
          if (method === "wallet_addEthereumChain") {
            added = true;
            chain = (params![0] as { chainId: string }).chainId;
            return null;
          }
          if (method === "eth_sendTransaction") {
            if (o.reject === "send") throw Object.assign(new Error("User denied transaction signature."), { code: 4001 });
            return tx;
          }
          throw Object.assign(new Error(`Unsupported ${method}`), { code: 4200 });
        },
      };
    },
    { o: opts, payer: PAYER, tx: TX },
  );
}

const walletCalls = (page: Page) => page.evaluate(() => (window as unknown as { __eth: { method: string; params?: unknown[] }[] }).__eth);

async function getInstructions(page: Page, query: string, option: string) {
  await page.goto("/#/pay/pub1");
  await pickToken(page, "pay-token", query, option);
  await page.getByLabel(/^Refund address on /).fill(REFUND);
  await page.getByRole("button", { name: "Get payment instructions" }).click();
  await expect(page.locator("#pay-address")).toHaveText(QUOTES[query === "eth" ? ETH_ARB : query === "sol" ? "nep141:sol.omft.near" : USDC_ARB].depositAddress);
}

test("native ETH on Arbitrum: review, one click, exact value to the deposit address, deposit POST, Processing", async ({ page }) => {
  const seen = await mockApi(page);
  await installWallet(page, { chainId: "0xa4b1" });
  await getInstructions(page, "eth", "ETH, Arbitrum");
  const review = page.locator("#pay-wallet-review");
  await expect(review).toContainText("send exactly 0.0003 ETH on Arbitrum One (chain 42161)");
  await expect(review).toContainText(DEPOSIT);
  // Nothing is asked of the wallet before the click (eth_accounts for the refund chips never opens a popup).
  expect((await walletCalls(page)).filter((c) => c.method !== "eth_accounts")).toEqual([]);
  await page.getByRole("button", { name: "Pay with wallet" }).click();
  await expect(page.getByRole("heading", { name: "Processing" })).toBeVisible();
  await expect(page.locator("#pay-tx")).toHaveText(TX);
  await expect(page.getByText("Your wallet sent the payment of 0.0003 ETH")).toBeVisible();
  const calls = await walletCalls(page);
  expect(calls.map((c) => c.method)).not.toContain("wallet_switchEthereumChain");
  const send = calls.find((c) => c.method === "eth_sendTransaction")!;
  expect(send.params).toEqual([{ from: PAYER, to: DEPOSIT, value: "0x110d9316ec000" }]);
  await expect.poll(() => seen.deposit).toEqual([{ depositAddress: DEPOSIT, txHash: TX }]);
  // After a reload the attempt is still PENDING_DEPOSIT upstream, but this browser remembers it already paid
  // that address: it shows Processing again, never a second Pay button.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Processing" })).toBeVisible();
  await expect(page.locator("#pay-tx")).toHaveText(TX);
  await expect(page.locator("#pay-wallet")).toHaveCount(0);
});

test("ERC-20 USDC: switches the wallet from Ethereum to Arbitrum, then transfer() calldata to the token contract", async ({ page }) => {
  const seen = await mockApi(page);
  await installWallet(page, { chainId: "0x1" });
  await getInstructions(page, "usdc", "USDC, Arbitrum");
  await expect(page.locator("#pay-wallet-review")).toContainText(`token contract ${USDC_ARB_CONTRACT}`);
  await page.getByRole("button", { name: "Pay with wallet" }).click();
  await expect(page.getByRole("heading", { name: "Processing" })).toBeVisible();
  const calls = await walletCalls(page);
  const methods = calls.map((c) => c.method);
  expect(methods.indexOf("wallet_switchEthereumChain")).toBeLessThan(methods.indexOf("eth_sendTransaction"));
  expect(calls.find((c) => c.method === "wallet_switchEthereumChain")!.params).toEqual([{ chainId: "0xa4b1" }]);
  expect(calls.find((c) => c.method === "eth_sendTransaction")!.params).toEqual([
    {
      from: PAYER,
      to: USDC_ARB_CONTRACT,
      value: "0x0",
      data: `0xa9059cbb${DEPOSIT.slice(2).padStart(64, "0")}${(710180).toString(16).padStart(64, "0")}`,
    },
  ]);
  await expect.poll(() => seen.deposit).toEqual([{ depositAddress: DEPOSIT, txHash: TX }]);
});

test("a chain the wallet does not know is added with wallet_addEthereumChain, then paid", async ({ page }) => {
  await mockApi(page);
  await installWallet(page, { chainId: "0x1", unknownChain: true });
  await getInstructions(page, "usdc", "USDC, Arbitrum");
  await page.getByRole("button", { name: "Pay with wallet" }).click();
  await expect(page.getByRole("heading", { name: "Processing" })).toBeVisible();
  const add = (await walletCalls(page)).find((c) => c.method === "wallet_addEthereumChain")!;
  expect(add.params).toEqual([
    { chainId: "0xa4b1", chainName: "Arbitrum One", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: ["https://arb1.arbitrum.io/rpc"], blockExplorerUrls: ["https://arbiscan.io"] },
  ]);
});

for (const reject of ["send", "switch"] as const) {
  test(`rejecting the ${reject === "send" ? "transaction" : "network switch"} says nothing was sent and posts no deposit`, async ({ page }) => {
    const seen = await mockApi(page);
    await installWallet(page, { chainId: reject === "switch" ? "0x1" : "0xa4b1", reject });
    await getInstructions(page, "usdc", "USDC, Arbitrum");
    await page.getByRole("button", { name: "Pay with wallet" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "You declined in your wallet. Nothing was sent." })).toBeVisible();
    await expect(page.getByRole("button", { name: "Pay with wallet" })).toBeEnabled();
    await expect(page.locator("#pay-address")).toHaveText(DEPOSIT);
    expect(seen.deposit).toEqual([]);
    if (reject === "switch") expect((await walletCalls(page)).map((c) => c.method)).not.toContain("eth_sendTransaction");
  });
}

test("without a browser wallet: no Pay button, an EIP-681 link, and the copy fallback", async ({ page }) => {
  await mockApi(page);
  await getInstructions(page, "usdc", "USDC, Arbitrum");
  await expect(page.getByRole("button", { name: "Pay with wallet" })).toHaveCount(0);
  await expect(page.getByText("No browser wallet found on this device.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open in a mobile wallet" })).toHaveAttribute(
    "href",
    `ethereum:${USDC_ARB_CONTRACT}@42161/transfer?address=${DEPOSIT}&uint256=710180`,
  );
  await page.getByRole("button", { name: "Copy amount" }).click();
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy address" })).toBeVisible();
});

test("chains without wallet support here keep the manual flow and say so", async ({ page }) => {
  await mockApi(page);
  await installWallet(page, { chainId: "0x1" });
  await page.goto("/#/pay/pub1");
  await pickToken(page, "pay-token", "sol", "SOL, Solana");
  await page.getByLabel("Refund address on sol").fill("4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T");
  await page.getByRole("button", { name: "Get payment instructions" }).click();
  await expect(page.locator("#pay-address")).toBeVisible();
  await expect(page.getByText("Paying from a connected wallet is not available for this token on Solana (sol) yet.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Pay with/ })).toHaveCount(0);
});
