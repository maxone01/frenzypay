-- Invoice emails to the client (server/email.ts). One row per send attempt: it is inserted as 'sending' before
-- the SMTP call (the insert itself enforces the hourly limits) and then set to 'sent' or 'failed'.
-- `owner` is the invoice owner, kept here so the per-owner limit needs no join.
CREATE TABLE invoice_emails (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  owner TEXT NOT NULL,
  to_email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sending','sent','failed')),
  error TEXT,
  sent_at TEXT NOT NULL
);
CREATE INDEX invoice_emails_invoice ON invoice_emails(invoice_id, sent_at);
CREATE INDEX invoice_emails_owner ON invoice_emails(owner, sent_at);
