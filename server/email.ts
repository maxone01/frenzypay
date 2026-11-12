// Invoice email to the client: the payment link, sent over SMTP with worker-mailer (cloudflare:sockets, so it
// runs in workerd and `wrangler pages dev`). worker-mailer is imported lazily inside smtpTransport so the node
// test runner, which has no cloudflare:sockets, never loads it; tests pass their own Transport.
//
// Safety rules kept here, not in callers:
// - The recipient is always the invoice's stored clientEmail; a request can never choose the address.
// - Every header value is checked for CR/LF (worker-mailer passes plain-ASCII header text through as is).
// - User content in the HTML part is escaped; there are no images, so no tracking pixel.
// - SMTP credentials never reach a log line or a stored error.
import { settlementToken } from "../shared/assets.ts";
import { validEmail, type InvoiceRow } from "../shared/invoice.ts";
import { escapeHTML as esc } from "../shared/text.ts";
import { formatAmount } from "../shared/units.ts";
import type { Db } from "./db.ts";
import type { Env } from "./env.ts";
import { HttpError } from "./http.ts";

export type Mailbox = { name?: string; email: string };
export type MailConfig = {
  host: string;
  port: number;
  secure: "starttls" | "tls" | "none";
  user: string;
  pass: string;
  from: Mailbox;
  replyTo?: Mailbox;
};
export type OutgoingMail = { from: Mailbox; to: string; replyTo?: Mailbox; subject: string; text: string; html: string };
export type Transport = (cfg: MailConfig, mail: OutgoingMail) => Promise<void>;

export type EmailStatus = "sending" | "sent" | "failed";
export type EmailRecord = { to: string; status: EmailStatus; error?: string; sentAt: string };

export const MAX_PER_INVOICE_HOUR = 5;
export const MAX_PER_OWNER_HOUR = 30;
const SEND_TIMEOUT_MS = 25_000;
export const NOT_CONFIGURED = "Email is not configured";

const CRLF = /[\r\n]/;

/** Throws if a header value could start a new header line. */
export function assertHeader(value: string, what: string): string {
  if (CRLF.test(value)) throw new Error(`The ${what} contains a line break, so it cannot go in an email header.`);
  return value;
}

/** `Name <addr@host>` or a bare `addr@host`. Names may not hold quotes, backslashes, angle brackets or line breaks. */
export function parseMailbox(raw: string): Mailbox | null {
  const s = raw.trim();
  if (!s || CRLF.test(s)) return null;
  const m = /^(.*?)\s*<([^<>\s]+)>$/.exec(s);
  const name = m ? m[1].trim() : "";
  const email = (m ? m[2] : s).toLowerCase();
  if (!validEmail(email) || /["\\<>]/.test(name)) return null;
  return name ? { name, email } : { email };
}

/** The SMTP settings, or null when sending is off (any of host, user, pass, from missing or invalid). */
export function mailConfig(env: Env): MailConfig | null {
  const host = env.SMTP_HOST?.trim();
  const user = env.SMTP_USER ?? "";
  const pass = env.SMTP_PASS ?? "";
  const from = env.MAIL_FROM ? parseMailbox(env.MAIL_FROM) : null;
  if (!host || !user || !pass || !from || !/^[A-Za-z0-9.-]{1,253}$/.test(host)) return null;
  const port = env.SMTP_PORT?.trim() ? Number(env.SMTP_PORT) : 587;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const mode = (env.SMTP_SECURE?.trim().toLowerCase() || "starttls") as MailConfig["secure"];
  if (!["starttls", "tls", "none"].includes(mode)) return null;
  const replyTo = env.MAIL_REPLY_TO?.trim() ? parseMailbox(env.MAIL_REPLY_TO) : undefined;
  if (replyTo === null) return null;
  return { host, port, secure: mode, user, pass, from, ...(replyTo ? { replyTo } : {}) };
}

/** Origin for links in the email: PUBLIC_BASE_URL when it is a valid http(s) URL, else the request's origin. */
export function publicOrigin(env: Env, requestUrl: string): string {
  const base = env.PUBLIC_BASE_URL?.trim();
  if (base) {
    try {
      const u = new URL(base);
      if (u.protocol === "https:" || u.protocol === "http:") return u.origin;
    } catch {
      /* fall through to the request origin */
    }
  }
  return new URL(requestUrl).origin;
}

export const payUrl = (origin: string, publicId: string) => `${origin}/#/pay/${encodeURIComponent(publicId)}`;

/** Subject, plain text and HTML for an issued invoice. Pure; throws only on a header line break. */
export function invoiceEmail(inv: InvoiceRow, link: string): { subject: string; text: string; html: string } {
  const d = inv.data;
  const token = settlementToken(inv.tokenId);
  const amount = `${formatAmount(BigInt(inv.total), token.decimals)} ${token.symbol}`;
  const subject = assertHeader(`Invoice ${d.number} from ${d.issuer}`, "invoice number or business name");
  const due = d.dueDate ? `Due ${d.dueDate} (UTC)` : "";
  const footer = `Sent through FrenzyPay on behalf of ${d.issuer}.`;

  const text = [
    `Hi ${d.client},`,
    "",
    `${d.issuer} sent you invoice ${d.number}.`,
    "",
    `Amount: ${amount}`,
    ...(due ? [due] : []),
    "",
    `Pay invoice: ${link}`,
    "",
    "You can pay with a token you already hold on most chains; the amount is converted on NEAR Intents.",
    "",
    "--",
    footer,
  ].join("\n");

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:24px;background:#f5f7f6;color:#18332e;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e1e8e2;border-radius:13px">
<tr><td style="padding:28px">
<p style="margin:0 0 16px">Hi ${esc(d.client)},</p>
<p style="margin:0 0 20px"><strong>${esc(d.issuer)}</strong> sent you invoice <strong>${esc(d.number)}</strong>.</p>
<p style="margin:0;color:#56645c;font-size:13px">Amount</p>
<p style="margin:0 0 ${due ? "8px" : "24px"};font-size:24px;font-weight:600">${esc(amount)}</p>
${due ? `<p style="margin:0 0 24px;color:#56645c">${esc(due)}</p>` : ""}
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:8px;background:#2f6b3c">
<a href="${esc(link)}" style="display:inline-block;padding:12px 22px;color:#ffffff;text-decoration:none;font-weight:600;border-radius:8px">Pay invoice</a>
</td></tr></table>
<p style="margin:20px 0 0;color:#56645c;font-size:13px">Or open this link: <a href="${esc(link)}" style="color:#2f6b3c;word-break:break-all">${esc(link)}</a></p>
</td></tr></table>
<p style="max-width:520px;margin:16px auto 0;color:#56645c;font-size:12px;text-align:center">${esc(footer)}</p>
</body></html>`;
  return { subject, text, html };
}

/** Error text safe to store and show the owner: no credentials, one line, short. */
export function safeError(e: unknown, cfg: Pick<MailConfig, "user" | "pass">): string {
  let msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const b64 = (s: string) => {
    try {
      return btoa(s);
    } catch {
      return "";
    }
  };
  // AUTH sends both base64-encoded, so a server echoing the exchange back must not leak them either.
  for (const secret of [cfg.pass, cfg.user, b64(cfg.pass), b64(cfg.user)]) if (secret.length >= 3) msg = msg.split(secret).join("***");
  msg = msg.replace(/\s+/g, " ").trim().slice(0, 200);
  return msg || "The mail server did not accept the message.";
}

/** Real SMTP. STARTTLS on 587/2525, implicit TLS on 465, or plain (`none`, local test servers only). */
export const smtpTransport: Transport = async (cfg, mail) => {
  const { WorkerMailer, LogLevel } = await import("worker-mailer");
  const mailer = await WorkerMailer.connect({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure === "tls",
    startTls: cfg.secure === "starttls",
    credentials: { username: cfg.user, password: cfg.pass },
    authType: ["plain", "login"],
    // DEBUG would print the AUTH exchange (base64 credentials); nothing from the mailer is logged.
    logLevel: LogLevel.NONE,
    socketTimeoutMs: 10_000,
    responseTimeoutMs: 10_000,
  });
  try {
    await mailer.send({
      from: mail.from,
      to: mail.to,
      ...(mail.replyTo ? { reply: mail.replyTo } : {}),
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
  } finally {
    await mailer.close().catch(() => {});
  }
};

type Raw = { to_email: string; status: EmailStatus; error: string | null; sent_at: string };
const record = (r: Raw): EmailRecord => ({ to: r.to_email, status: r.status, ...(r.error ? { error: r.error } : {}), sentAt: r.sent_at });

export async function latestEmail(db: Db, invoiceId: string): Promise<EmailRecord | null> {
  const r = await db
    .prepare("SELECT to_email, status, error, sent_at FROM invoice_emails WHERE invoice_id = ? ORDER BY sent_at DESC, rowid DESC LIMIT 1")
    .bind(invoiceId)
    .first<Raw>();
  return r ? record(r) : null;
}

/**
 * Reserve one send. A single INSERT … SELECT … WHERE, so the hourly limits hold even for concurrent requests:
 * at most MAX_PER_INVOICE_HOUR rows per invoice and MAX_PER_OWNER_HOUR per owner in the last hour, failed
 * attempts included.
 */
async function reserve(db: Db, inv: InvoiceRow, to: string, now: Date): Promise<string> {
  const id = crypto.randomUUID();
  const since = new Date(now.getTime() - 3_600_000).toISOString();
  const r = await db
    .prepare(
      `INSERT INTO invoice_emails (id, invoice_id, owner, to_email, status, sent_at)
       SELECT ?, ?, ?, ?, 'sending', ?
       WHERE (SELECT COUNT(*) FROM invoice_emails WHERE invoice_id = ? AND sent_at > ?) < ?
         AND (SELECT COUNT(*) FROM invoice_emails WHERE owner = ? AND sent_at > ?) < ?`,
    )
    .bind(id, inv.id, inv.owner, to, now.toISOString(), inv.id, since, MAX_PER_INVOICE_HOUR, inv.owner, since, MAX_PER_OWNER_HOUR)
    .run();
  if (r.meta.changes === 1) return id;
  const n = await db.prepare("SELECT COUNT(*) AS n FROM invoice_emails WHERE invoice_id = ? AND sent_at > ?").bind(inv.id, since).first<{ n: number }>();
  throw new HttpError(
    429,
    (n?.n ?? 0) >= MAX_PER_INVOICE_HOUR
      ? `This invoice was emailed ${MAX_PER_INVOICE_HOUR} times in the last hour. Try again later or copy the link.`
      : `You sent ${MAX_PER_OWNER_HOUR} invoice emails in the last hour. Try again later or copy the link.`,
  );
}

export type SendDeps = { db: Db; env: Env; now: Date; origin: string; transport?: Transport };

/**
 * Email the payment link of an issued invoice to its clientEmail. Throws HttpError for "cannot try" cases
 * (no email on the invoice 400, not issued 409, not configured 503, rate limit 429); an SMTP failure is not
 * thrown but recorded and returned as status "failed".
 */
export async function sendInvoiceEmail(deps: SendDeps, inv: InvoiceRow): Promise<EmailRecord> {
  const to = inv.data.clientEmail;
  if (!to) throw new HttpError(400, "Add a client email to this invoice first.");
  if (inv.status !== "issued") throw new HttpError(409, "Only issued, unpaid invoices can be emailed.");
  const cfg = mailConfig(deps.env);
  if (!cfg) throw new HttpError(503, NOT_CONFIGURED);
  const id = await reserve(deps.db, inv, to, deps.now);
  let status: EmailStatus = "sent";
  let error: string | null = null;
  try {
    const msg = invoiceEmail(inv, payUrl(deps.origin, inv.publicId));
    const mail: OutgoingMail = { from: cfg.from, to: assertHeader(to, "client email"), ...(cfg.replyTo ? { replyTo: cfg.replyTo } : {}), ...msg };
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        (deps.transport ?? smtpTransport)(cfg, mail),
        new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("The mail server did not answer in time.")), SEND_TIMEOUT_MS))),
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  } catch (e) {
    status = "failed";
    error = safeError(e, cfg);
  }
  await deps.db.prepare("UPDATE invoice_emails SET status = ?, error = ? WHERE id = ?").bind(status, error, id).run();
  return { to, status, ...(error ? { error } : {}), sentAt: deps.now.toISOString() };
}

/** What the invoice page shows: whether sending is possible and the last attempt. */
export async function emailState(db: Db, env: Env, invoiceId: string): Promise<{ configured: boolean; last: EmailRecord | null }> {
  return { configured: mailConfig(env) !== null, last: await latestEmail(db, invoiceId) };
}
