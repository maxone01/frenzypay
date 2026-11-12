import { expect, test, type Page } from "@playwright/test";

const OWNER = "alice.near";
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

type Row = Record<string, unknown> & { id: string; status: string; revision: number; data: Record<string, unknown> };

async function mockApi(page: Page, payments: Record<string, unknown>[] = [], paidOnPayments = false) {
  const rows: Row[] = [];
  await page.route(/^(?!http:\/\/(127\.0\.0\.1|localhost)[:/]).*/, (r) => r.abort());
  await page.route("**/api/**", async (r) => {
    const req = r.request();
    const path = new URL(req.url()).pathname;
    const body = req.postData() ? JSON.parse(req.postData()!) : null;
    if (path === "/api/me") return r.fulfill({ json: { account: OWNER, kind: "near" } });
    if (path === "/api/invoices" && req.method() === "GET") return r.fulfill({ json: rows });
    if (path === "/api/invoices" && req.method() === "POST") {
      const row: Row = {
        id: `id${rows.length + 1}`, publicId: `pub${rows.length + 1}`, owner: OWNER, status: "draft", tokenId: USDC, data: body,
        total: "700000", revision: 1, createdAt: "2030-01-01T00:00:00Z", updatedAt: "2030-01-01T00:00:00Z",
      };
      rows.push(row);
      return r.fulfill({ status: 201, json: row });
    }
    const pm = /^\/api\/invoices\/([^/]+)\/payments$/.exec(path);
    const prow = pm && rows.find((x) => x.id === pm[1]);
    if (prow) {
      if (paidOnPayments) Object.assign(prow, { status: "paid", paidAt: "2030-01-02T00:00:00Z", paidBy: "dep1" });
      return r.fulfill({ json: { invoiceStatus: prow.status, attempts: payments } });
    }
    const m = /^\/api\/invoices\/([^/]+)(?:\/(issue|cancel))?$/.exec(path);
    const row = m && rows.find((x) => x.id === m[1]);
    if (m && row) {
      if (m[2] === "issue") Object.assign(row, { status: "issued", issuedAt: "2030-01-01T00:00:00Z", revision: row.revision + 1 });
      if (m[2] === "cancel") Object.assign(row, { status: "cancelled", revision: row.revision + 1 });
      if (req.method() === "PUT") Object.assign(row, { data: body.data, revision: row.revision + 1 });
      return r.fulfill({ json: row });
    }
    return r.fulfill({ status: 404, json: { error: "Not found" } });
  });
  return rows;
}

async function createAndIssue(page: Page, clientEmail = "") {
  await page.goto("/#/invoices");
  await page.getByRole("link", { name: "+ New invoice" }).click();
  await page.locator("#invoice-number").fill("DEMO-001");
  await page.locator("#invoice-issuer").fill("Example Studio");
  await page.locator("#invoice-client").fill("Demo Client");
  if (clientEmail) await page.getByLabel("Client email (optional)").fill(clientEmail);
  await page.getByLabel("Description 1", { exact: true }).fill("Design");
  await page.getByLabel("Quantity 1", { exact: true }).fill("3");
  await page.getByLabel("Unit price 1", { exact: true }).fill("0.1");
  await page.getByRole("button", { name: "+ Add line item" }).click();
  await page.getByLabel("Description 2", { exact: true }).fill("Build");
  await page.getByLabel("Quantity 2", { exact: true }).fill("2");
  await page.getByLabel("Unit price 2", { exact: true }).fill("0.2");
  await expect(page.locator("#invoice-totals")).toContainText("0.7 USDC");
  await page.getByRole("button", { name: "Issue invoice" }).click();
}

test("token select offers only USDC and USDT", async ({ page }) => {
  await mockApi(page);
  await page.goto("/#/invoices/new");
  await expect(page.locator("#invoice-token option")).toHaveText(["USDC", "USDT"]);
});

test("create and issue an invoice, list it, copy its payment link", async ({ page }) => {
  await mockApi(page);
  await createAndIssue(page);
  await expect(page.getByRole("heading", { name: "DEMO-001" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy payment link" })).toBeVisible();
  await expect(page.locator("#invoice-link")).toHaveValue(/#\/pay\/pub1$/);
  await page.getByRole("link", { name: "← Invoices" }).click();
  const row = page.locator(".invoice-record", { hasText: "DEMO-001" });
  await expect(row).toContainText("0.7 USDC");
  await expect(row).toContainText("Issued");
  await page.getByLabel("Filter by status").selectOption("paid");
  await expect(page.getByText("No invoices in this view.")).toBeVisible();
});

test("cancel and duplicate an issued invoice", async ({ page }) => {
  await mockApi(page);
  page.on("dialog", (d) => d.accept());
  await createAndIssue(page);
  await page.getByRole("button", { name: "Cancel invoice" }).click();
  await expect(page.locator(".badge", { hasText: "Cancelled" })).toBeVisible();
  await page.getByRole("button", { name: "Duplicate as new draft" }).click();
  await expect(page.getByRole("heading", { name: "Edit draft" })).toBeVisible();
  await expect(page.locator("#invoice-number")).toHaveValue(/^DEMO-001-/);
});

const attempt = (over: Record<string, unknown>) => ({
  symbol: "USDC", blockchain: "arb", depositAddress: "dep1", originAsset: "nep141:arb", amountIn: "710180", amountInFormatted: "0.71018",
  status: "SUCCESS", expired: false, createdAt: "2030-01-01T00:05:00.000Z", refundTo: "0x1", originTxHashes: ["0xorigin"],
  destinationTxHashes: ["6xJZ3tYbKk7d8m9QpR2sT4uV5wX6yZ7aB8cD9eF1gH2j"], amountOut: "700000", amountOutFormatted: "0.7", ...over,
});

test("owner sees verified payments, extra payments and the Paid chip", async ({ page }) => {
  await mockApi(page, [attempt({ depositAddress: "dep2", outcome: "duplicate" }), attempt({ outcome: "paid" }), attempt({ depositAddress: "dep3", status: "REFUNDED", outcome: "refunded", destinationTxHashes: [], originTxHashes: [] })], true);
  await createAndIssue(page);
  await expect(page.locator(".heading .badge.status-paid")).toContainText("Paid");
  await expect(page.getByText(/paid 2030-01-02/)).toBeVisible();
  const list = page.locator("#invoice-payments");
  await expect(list.locator(".payment-row")).toHaveCount(3);
  await expect(list.locator('[data-deposit="dep2"]')).toContainText("Extra payment received (in your balance)");
  await expect(list.locator('[data-deposit="dep1"] .badge')).toHaveText("Paid");
  await expect(list.locator('[data-deposit="dep1"]')).toContainText("Received 0.7 USDC");
  await expect(list.locator('[data-deposit="dep1"] a')).toHaveAttribute("href", /^https:\/\/nearblocks\.io\/txns\//);
  await expect(list.locator('[data-deposit="dep3"] .badge')).toHaveText("Refunded");
  await page.getByRole("link", { name: "← Invoices" }).click();
  await expect(page.locator(".invoice-record", { hasText: "DEMO-001" }).locator(".badge.status-paid")).toHaveText("✓ Paid");
});

test("owner sees a mismatched payment as Needs review with the received amount", async ({ page }) => {
  await mockApi(page, [attempt({ outcome: "mismatch", amountOut: "699999", amountOutFormatted: "0.699999" })]);
  await createAndIssue(page);
  const row = page.locator('#invoice-payments [data-deposit="dep1"]');
  await expect(row.locator(".badge")).toHaveText("Needs review");
  await expect(row).toContainText("Received 0.699999 USDC");
  await expect(page.locator(".heading .badge.status-issued")).toBeVisible();
});

test("owner sees a mismatch with no received amount as not received by their account", async ({ page }) => {
  await mockApi(page, [attempt({ outcome: "mismatch", amountOut: undefined, amountOutFormatted: undefined })]);
  await createAndIssue(page);
  const row = page.locator('#invoice-payments [data-deposit="dep1"]');
  await expect(row.locator(".badge")).toHaveText("Needs review");
  await expect(row).toContainText("Not received by your account — needs review");
  await expect(row).not.toContainText(/Received \d/);
});

test("the invoice list says payment status updates when an invoice is opened", async ({ page }) => {
  await mockApi(page);
  await page.goto("/#/invoices");
  await expect(page.getByText("Payment status updates when you open an invoice.")).toBeVisible();
});

/** Email routes on top of mockApi: Issue answers with `issueEmail`, GET /send with `state`, POST /send with `sendResult`. */
async function mockEmail(page: Page, rows: Row[], o: { issueEmail: Record<string, unknown>; state: Record<string, unknown>; sendResult?: Record<string, unknown> }) {
  const posts: string[] = [];
  await page.route(/\/api\/invoices\/[^/]+\/issue$/, (r) => {
    const row = rows.find((x) => r.request().url().includes(`/api/invoices/${x.id}/`))!;
    Object.assign(row, { status: "issued", issuedAt: "2030-01-01T00:00:00Z", revision: row.revision + 1 });
    return r.fulfill({ json: { ...row, email: o.issueEmail } });
  });
  await page.route(/\/api\/invoices\/[^/]+\/send$/, (r) => {
    if (r.request().method() === "GET") return r.fulfill({ json: o.state });
    posts.push(r.request().url());
    return r.fulfill({ json: o.sendResult });
  });
  return posts;
}

test("issue with a client email: a failed email still issues, says to copy the link, and Resend works", async ({ page }) => {
  const rows = await mockApi(page);
  const failed = { to: "billing@client.example", status: "failed", error: "535 Authentication failed", sentAt: "2030-01-01T00:00:00.000Z" };
  const posts = await mockEmail(page, rows, {
    issueEmail: { status: "failed", error: "535 Authentication failed" },
    state: { configured: true, last: failed },
    sendResult: { to: "billing@client.example", status: "sent", sentAt: "2030-01-01T00:10:00.000Z" },
  });
  await createAndIssue(page, "  billing@client.example ");
  expect(rows[0].data.clientEmail).toBe("billing@client.example");
  await expect(page.getByRole("alert").filter({ hasText: "Invoice issued, email failed. Copy the link. (535 Authentication failed)" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy payment link" })).toBeVisible();
  await expect(page.getByText("Email to billing@client.example failed on 2030-01-01 00:00 UTC: 535 Authentication failed")).toBeVisible();
  await page.getByRole("button", { name: "Resend email" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Email sent to billing@client.example." })).toBeVisible();
  await expect(page.getByText("Emailed to billing@client.example on 2030-01-01 00:10 UTC.")).toBeVisible();
  expect(posts).toHaveLength(1);
});

test("issue when email is not configured says so and offers no Send button", async ({ page }) => {
  const rows = await mockApi(page);
  await mockEmail(page, rows, { issueEmail: { status: "not_configured", error: "Email is not configured" }, state: { configured: false, last: null } });
  await createAndIssue(page, "billing@client.example");
  await expect(page.getByText("Invoice issued. Email is not configured, so copy the link below and send it yourself.")).toBeVisible();
  await expect(page.getByText("Email is not configured. Copy the link and send it to billing@client.example yourself.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Send email|Resend email/ })).toHaveCount(0);
});

test("issue with a client email that was sent shows the confirmation and a Resend button", async ({ page }) => {
  const rows = await mockApi(page);
  await mockEmail(page, rows, {
    issueEmail: { status: "sent" },
    state: { configured: true, last: { to: "billing@client.example", status: "sent", sentAt: "2030-01-01T00:00:00.000Z" } },
  });
  await createAndIssue(page, "billing@client.example");
  await expect(page.getByText("Invoice issued and emailed to billing@client.example.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Resend email" })).toBeVisible();
});

const CHAIN_ON = { writes: true, network: "mainnet", contractId: "frenzypay.maxkumbang.near" };

test("on-chain off (default): no notice and no On-chain row", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/chain/config", (r) => r.fulfill({ json: { writes: false, network: "mainnet" } }));
  await page.goto("/#/invoices/new");
  await expect(page.locator("#invoice-form")).toBeVisible();
  await expect(page.locator(".chain-notice")).toHaveCount(0);
  await createAndIssue(page);
  await expect(page.getByRole("heading", { name: "DEMO-001" })).toBeVisible();
  await expect(page.locator("#chain-row")).toHaveCount(0);
});

test("on-chain on: Why public notice before issuing, then an On-chain row with the explorer link", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/chain/config", (r) => r.fulfill({ json: CHAIN_ON }));
  await page.route(/\/api\/chain\/invoice\/[^/]+$/, (r) =>
    r.fulfill({ json: { status: "confirmed", synced: "issued", tx: "TxHash1", txUrl: "https://nearblocks.io/txns/TxHash1", canPublish: false, network: "mainnet" } }),
  );
  await page.goto("/#/invoices/new");
  await expect(page.locator("#chain-notice")).toContainText("permanent and visible to anyone");
  await createAndIssue(page);
  const row = page.locator("#chain-row");
  await expect(row).toContainText("Recorded (issued)");
  await expect(row.getByRole("link", { name: "View transaction" })).toHaveAttribute("href", "https://nearblocks.io/txns/TxHash1");
});

test("on-chain failure never blocks the invoice: Failed with the reason and Retry", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/chain/config", (r) => r.fulfill({ json: CHAIN_ON }));
  await page.route(/\/api\/chain\/invoice\/[^/]+$/, (r) =>
    r.fulfill({ json: { status: "failed", error: "NEAR RPC is unavailable. Try again later.", canPublish: true, network: "mainnet" } }),
  );
  await createAndIssue(page);
  await expect(page.getByRole("button", { name: "Copy payment link" })).toBeVisible();
  await expect(page.locator("#chain-row")).toContainText("Failed");
  await expect(page.locator("#chain-row .chain-error")).toHaveText("NEAR RPC is unavailable. Try again later.");
  await expect(page.locator("#chain-publish")).toHaveText("Retry");
});
