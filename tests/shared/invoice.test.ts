import test from "node:test";
import assert from "node:assert/strict";
import { invoiceTotal, readClientEmail, readDraft, validEmail, validateDraft, type InvoiceDraft } from "../../shared/invoice.ts";
import { SETTLEMENT_TOKENS } from "../../shared/assets.ts";

const USDC = SETTLEMENT_TOKENS[0].tokenId;
const draft = (over: Partial<InvoiceDraft> = {}): InvoiceDraft => ({
  number: "DEMO-001",
  client: "Demo Client",
  issuer: "Example Studio",
  dueDate: "2030-01-31",
  tokenId: USDC,
  notes: "",
  items: [
    { description: "Design", quantity: "3", unitPrice: "0.1" },
    { description: "Build", quantity: "2", unitPrice: "0.2" },
  ],
  ...over,
});

test("invoiceTotal sums quantity x unit price in base units", () => {
  assert.equal(invoiceTotal(draft()), 700000n);
});

test("zero quantity is rejected with the line number", () => {
  const d = draft({ items: [{ description: "x", quantity: "0", unitPrice: "1" }] });
  assert.throws(() => invoiceTotal(d), { message: "Line 1: use a whole quantity from 1 to 9999." });
});

test("unknown token is rejected", () => {
  assert.throws(() => invoiceTotal(draft({ tokenId: "nep141:evil" })), /Unknown settlement token/);
  assert.throws(() => validateDraft(draft({ tokenId: "nep141:evil" })));
});

test("readDraft checks shape and limits only", () => {
  assert.deepEqual(readDraft({ ...draft(), extra: 1 }), draft());
  assert.throws(() => readDraft(null));
  assert.throws(() => readDraft(draft({ number: "x".repeat(33) })));
  assert.throws(() => readDraft(draft({ items: [] })));
  assert.throws(() => readDraft(draft({ items: Array(11).fill({ description: "a", quantity: "1", unitPrice: "1" }) })));
  // incomplete drafts are fine for readDraft
  assert.equal(readDraft(draft({ number: "", client: "" })).number, "");
});

test("clientEmail is optional, trimmed and lowercased, and must be a plain address", () => {
  assert.equal("clientEmail" in readDraft(draft()), false);
  assert.equal("clientEmail" in readDraft({ ...draft(), clientEmail: "   " }), false);
  assert.equal("clientEmail" in readDraft({ ...draft(), clientEmail: null }), false);
  assert.equal(readDraft({ ...draft(), clientEmail: "  Billing@Client.Example " }).clientEmail, "billing@client.example");
  assert.equal(readClientEmail("a.b+tag@sub.client.example"), "a.b+tag@sub.client.example");
  for (const bad of [
    "no-at-sign", "a@b", "a@-b.example", "a@b.example\r\nBcc: c@d.example", "<a@b.example>", "a,b@c.example", '"q"@b.example',
    "a@b.example.", `${"x".repeat(65)}@b.example`, `a@${"b".repeat(250)}.example`, 42,
  ])
    assert.throws(() => readClientEmail(bad), /valid client email/, String(bad));
  assert.equal(validEmail(`${"x".repeat(64)}@b.example`), true);
});

test("validateDraft enforces completeness", () => {
  assert.deepEqual(validateDraft(draft()), draft());
  assert.throws(() => validateDraft(draft({ number: " " })), /invoice number/i);
  assert.throws(() => validateDraft(draft({ dueDate: "2030-02-31" })), /due date/i);
  assert.throws(() => validateDraft(draft({ items: [{ description: " ", quantity: "1", unitPrice: "1" }] })), /description/i);
  assert.throws(() => validateDraft(draft({ items: [{ description: "a", quantity: "1", unitPrice: "0.0000001" }] })), /unit price/i);
});
