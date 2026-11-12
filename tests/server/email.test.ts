import test from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./d1-shim.ts";
import {
  MAX_PER_INVOICE_HOUR, MAX_PER_OWNER_HOUR, emailState, invoiceEmail, latestEmail, mailConfig, parseMailbox, payUrl, publicOrigin, safeError,
  sendInvoiceEmail, type MailConfig, type OutgoingMail, type Transport,
} from "../../server/email.ts";
import { createInvoice, getPublicInvoice, issueInvoice } from "../../server/invoices.ts";
import { signSession } from "../../server/session.ts";
import { SETTLEMENT_TOKENS } from "../../shared/assets.ts";
import type { Env } from "../../server/env.ts";
import type { InvoiceDraft } from "../../shared/invoice.ts";
import { onRequestPost as issuePost } from "../../functions/api/invoices/[id]/issue.ts";
import { onRequestGet as sendGet, onRequestPost as sendPost } from "../../functions/api/invoices/[id]/send.ts";

const OWNER = "alice.near";
const SECRET = "s".repeat(32);
const NOW = new Date("2030-01-01T00:00:00.000Z");
const draft: InvoiceDraft = {
  number: "INV-7", client: "Demo Client", issuer: "Example Studio", dueDate: "2030-01-31", tokenId: SETTLEMENT_TOKENS[0].tokenId, notes: "",
  items: [{ description: "Design", quantity: "1", unitPrice: "12.5" }], clientEmail: "billing@client.example",
};
const SMTP = { SMTP_HOST: "smtp.test", SMTP_USER: "user-123", SMTP_PASS: "pa55-secret-word", MAIL_FROM: "FrenzyPay <invoice@frenzypay.test>" };
const env = (over: Partial<Env> = {}): Env => ({
  DB: createTestDb(), SESSION_SECRET: SECRET, NEAR_RPC_URL: "https://rpc.test/", ONECLICK_BASE_URL: "https://oneclick.test", ...SMTP, ...over,
});

async function issued(e: Env, d: InvoiceDraft = draft, owner = OWNER) {
  const inv = await createInvoice(e.DB, owner, d, NOW.toISOString());
  return issueInvoice(e.DB, owner, inv.id, NOW.toISOString());
}

function recorder(fail?: Error) {
  const sent: { cfg: MailConfig; mail: OutgoingMail }[] = [];
  const transport: Transport = async (cfg, mail) => {
    sent.push({ cfg, mail });
    if (fail) throw fail;
  };
  return { sent, transport };
}

const status = (p: Promise<unknown>) => p.then(() => 0, (e: { status?: number }) => e.status);

test("mailConfig is null (sending disabled) unless host, user, pass and from are all set", () => {
  assert.equal(mailConfig(env({ SMTP_HOST: undefined })), null);
  assert.equal(mailConfig(env({ SMTP_USER: "" })), null);
  assert.equal(mailConfig(env({ SMTP_PASS: undefined })), null);
  assert.equal(mailConfig(env({ MAIL_FROM: undefined })), null);
  assert.equal(mailConfig(env({ MAIL_FROM: "not an address" })), null);
  assert.equal(mailConfig(env({ SMTP_SECURE: "ssl3" })), null);
  assert.equal(mailConfig(env({ SMTP_PORT: "99999" })), null);
  assert.equal(mailConfig(env({ SMTP_HOST: "smtp.test\r\nX: y" })), null);
  const c = mailConfig(env())!;
  assert.deepEqual({ host: c.host, port: c.port, secure: c.secure, from: c.from }, {
    host: "smtp.test", port: 587, secure: "starttls", from: { name: "FrenzyPay", email: "invoice@frenzypay.test" },
  });
  assert.equal(mailConfig(env({ SMTP_PORT: "2525", SMTP_SECURE: "TLS" }))!.port, 2525);
  assert.equal(mailConfig(env({ SMTP_SECURE: "TLS" }))!.secure, "tls");
});

test("parseMailbox rejects header injection and quote-breaking names", () => {
  assert.deepEqual(parseMailbox("billing@x.example"), { email: "billing@x.example" });
  assert.equal(parseMailbox("A <a@x.example>\r\nBcc: victim@y.example"), null);
  assert.equal(parseMailbox('Evil" <a@x.example>'), null);
  assert.equal(parseMailbox("a@x.example\nBcc: b@y.example"), null);
});

test("publicOrigin prefers PUBLIC_BASE_URL and falls back to the request origin", () => {
  assert.equal(publicOrigin(env({ PUBLIC_BASE_URL: "https://frenzypay.app/some/path" }), "http://127.0.0.1:24011/api/x"), "https://frenzypay.app");
  assert.equal(publicOrigin(env({ PUBLIC_BASE_URL: "javascript:alert(1)" }), "http://127.0.0.1:24011/api/x"), "http://127.0.0.1:24011");
  assert.equal(publicOrigin(env(), "http://127.0.0.1:24011/api/x"), "http://127.0.0.1:24011");
  assert.equal(payUrl("https://frenzypay.app", "ab_C-1"), "https://frenzypay.app/#/pay/ab_C-1");
});

test("invoiceEmail escapes user content, has a Pay invoice link and footer, and no images", async () => {
  const e = env();
  const inv = await issued(e, { ...draft, issuer: `<script>alert(1)</script> & Co`, client: `"><img src=x onerror=alert(1)>` });
  const m = invoiceEmail(inv, "https://frenzypay.app/#/pay/abc");
  assert.equal(m.subject, "Invoice INV-7 from <script>alert(1)</script> & Co");
  assert.ok(!m.html.includes("<script>"));
  assert.ok(!/<img/i.test(m.html), "no images, so no tracking pixel");
  assert.ok(m.html.includes("&lt;script&gt;alert(1)&lt;/script&gt; &amp; Co"));
  assert.ok(m.html.includes("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(m.html.includes('href="https://frenzypay.app/#/pay/abc"'));
  assert.ok(m.html.includes(">Pay invoice</a>"));
  assert.ok(m.html.includes("12.5 USDC"));
  assert.ok(m.html.includes("Due 2030-01-31 (UTC)"));
  assert.ok(m.text.includes("Pay invoice: https://frenzypay.app/#/pay/abc"));
  assert.ok(m.text.includes("Sent through FrenzyPay on behalf of <script>alert(1)</script> & Co."));
});

test("a line break in the business name never reaches a header: the send fails and is recorded", async () => {
  const e = env();
  const inv = await issued(e, { ...draft, issuer: "Studio\r\nBcc: victim@y.example" });
  const { sent, transport } = recorder();
  const r = await sendInvoiceEmail({ db: e.DB, env: e, now: NOW, origin: "https://frenzypay.app", transport }, inv);
  assert.equal(r.status, "failed");
  assert.match(r.error!, /line break/);
  assert.equal(sent.length, 0);
});

test("send delivers to the stored client email with the pay link and records it", async () => {
  const e = env({ MAIL_REPLY_TO: "owner@studio.example" });
  const inv = await issued(e);
  const { sent, transport } = recorder();
  const r = await sendInvoiceEmail({ db: e.DB, env: e, now: NOW, origin: "https://frenzypay.app", transport }, inv);
  assert.deepEqual(r, { to: "billing@client.example", status: "sent", sentAt: NOW.toISOString() });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].mail.to, "billing@client.example");
  assert.deepEqual(sent[0].mail.from, { name: "FrenzyPay", email: "invoice@frenzypay.test" });
  assert.deepEqual(sent[0].mail.replyTo, { email: "owner@studio.example" });
  assert.ok(sent[0].mail.text.includes(`https://frenzypay.app/#/pay/${inv.publicId}`));
  assert.deepEqual(await latestEmail(e.DB, inv.id), { to: "billing@client.example", status: "sent", sentAt: NOW.toISOString() });
});

test("an SMTP failure is recorded as failed with the credentials scrubbed, not thrown", async () => {
  const e = env();
  const inv = await issued(e);
  const { transport } = recorder(new Error(`535 auth failed for user-123 with pa55-secret-word (${btoa("pa55-secret-word")})`));
  const r = await sendInvoiceEmail({ db: e.DB, env: e, now: NOW, origin: "https://frenzypay.app", transport }, inv);
  assert.equal(r.status, "failed");
  assert.ok(!r.error!.includes("pa55-secret-word") && !r.error!.includes("user-123") && !r.error!.includes(btoa("pa55-secret-word")));
  assert.equal((await latestEmail(e.DB, inv.id))?.status, "failed");
  assert.equal(safeError(new Error(""), { user: "u", pass: "p" }), "The mail server did not accept the message.");
});

test("disabled, missing email and non-issued invoices are refused before any send", async () => {
  const e = env({ SMTP_PASS: "" });
  const inv = await issued(e);
  const { sent, transport } = recorder();
  const deps = { db: e.DB, env: e, now: NOW, origin: "https://frenzypay.app", transport };
  await assert.rejects(sendInvoiceEmail(deps, inv), { status: 503, message: "Email is not configured" });
  const on = { ...deps, env: env() };
  const noEmail = await issued(e, { ...draft, clientEmail: undefined });
  assert.equal(await status(sendInvoiceEmail(on, noEmail)), 400);
  const d = await createInvoice(e.DB, OWNER, draft, NOW.toISOString());
  assert.equal(await status(sendInvoiceEmail(on, d)), 409);
  assert.equal(sent.length, 0);
});

test("rate limit: 5 sends per invoice per hour, failed attempts included; the window slides", async () => {
  const e = env();
  const inv = await issued(e);
  const ok = recorder();
  const bad = recorder(new Error("421 try later"));
  for (let n = 0; n < MAX_PER_INVOICE_HOUR; n++)
    await sendInvoiceEmail({ db: e.DB, env: e, now: new Date(NOW.getTime() + n * 60_000), origin: "o", transport: n % 2 ? bad.transport : ok.transport }, inv);
  const later = new Date(NOW.getTime() + 10 * 60_000);
  await assert.rejects(sendInvoiceEmail({ db: e.DB, env: e, now: later, origin: "o", transport: ok.transport }, inv), { status: 429, message: /This invoice was emailed 5 times/ });
  // Just over an hour after the first send, one slot is free again.
  const r = await sendInvoiceEmail({ db: e.DB, env: e, now: new Date(NOW.getTime() + 3_600_001), origin: "o", transport: ok.transport }, inv);
  assert.equal(r.status, "sent");
});

test("rate limit: 30 sends per owner per hour across invoices; other owners are unaffected", async () => {
  const e = env();
  const { transport } = recorder();
  const invs = [];
  for (let n = 0; n < 7; n++) invs.push(await issued(e));
  let sentCount = 0;
  for (const inv of invs)
    for (let k = 0; k < 5 && sentCount < MAX_PER_OWNER_HOUR; k++, sentCount++)
      await sendInvoiceEmail({ db: e.DB, env: e, now: NOW, origin: "o", transport }, inv);
  await assert.rejects(sendInvoiceEmail({ db: e.DB, env: e, now: NOW, origin: "o", transport }, invs[6]), { status: 429, message: /You sent 30 invoice emails/ });
  const other = await issued(e, draft, "bob.near");
  assert.equal((await sendInvoiceEmail({ db: e.DB, env: e, now: NOW, origin: "o", transport }, other)).status, "sent");
});

test("the public invoice never exposes the client email", async () => {
  const e = env();
  const inv = await issued(e);
  const p = await getPublicInvoice(e.DB, inv.publicId);
  assert.equal((p.data as InvoiceDraft).clientEmail, undefined);
  assert.ok(!JSON.stringify(p).includes("billing@client.example"));
});

// --- routes ---

async function req(e: Env, path: string, method = "POST", account = OWNER) {
  const cookie = `mx_session=${await signSession(account, "near", SECRET)}`;
  return new Request(`http://127.0.0.1:24011${path}`, { method, headers: { cookie } });
}
const ctx = (request: Request, e: Env, id: string) => ({ request, env: e, params: { id } }) as unknown as Parameters<PagesFunction<Env>>[0];

test("issue route: email not configured still issues and says so", async () => {
  const e = env({ SMTP_HOST: "" });
  const d = await createInvoice(e.DB, OWNER, draft, NOW.toISOString());
  const res = await issuePost(ctx(await req(e, `/api/invoices/${d.id}/issue`), e, d.id));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "issued");
  assert.deepEqual(body.email, { status: "not_configured", error: "Email is not configured" });
});

test("issue route: an SMTP failure never blocks issuing", async () => {
  // Under node the real transport cannot load cloudflare:sockets, so the send fails like an unreachable server.
  const e = env();
  const d = await createInvoice(e.DB, OWNER, draft, NOW.toISOString());
  const res = await issuePost(ctx(await req(e, `/api/invoices/${d.id}/issue`), e, d.id));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "issued");
  assert.equal(body.email.status, "failed");
  assert.equal((await latestEmail(e.DB, d.id))?.status, "failed");
});

test("issue route without a client email returns the plain invoice", async () => {
  const e = env();
  const d = await createInvoice(e.DB, OWNER, { ...draft, clientEmail: undefined }, NOW.toISOString());
  const body = await (await issuePost(ctx(await req(e, `/api/invoices/${d.id}/issue`), e, d.id))).json();
  assert.equal(body.status, "issued");
  assert.equal(body.email, undefined);
});

test("send route is owner only and reports configuration", async () => {
  const e = env({ SMTP_HOST: "" });
  const inv = await issued(e);
  const anon = new Request(`http://127.0.0.1/api/invoices/${inv.id}/send`, { method: "POST" });
  assert.equal((await sendPost(ctx(anon, e, inv.id))).status, 401);
  assert.equal((await sendPost(ctx(await req(e, "/x", "POST", "mallory.near"), e, inv.id))).status, 404);
  const res = await sendPost(ctx(await req(e, "/x"), e, inv.id));
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "Email is not configured" });
  assert.deepEqual(await (await sendGet(ctx(await req(e, "/x", "GET"), e, inv.id))).json(), { configured: false, last: null });
  assert.deepEqual(await emailState(e.DB, env(), inv.id), { configured: true, last: null });
});
