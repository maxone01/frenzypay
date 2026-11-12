import { NOT_CONFIGURED, publicOrigin, sendInvoiceEmail, type EmailRecord } from "../../../../server/email.ts";
import type { Env } from "../../../../server/env.ts";
import { HttpError, handle, json } from "../../../../server/http.ts";
import { issueInvoice } from "../../../../server/invoices.ts";
import { requireUser } from "../../../../server/session.ts";

export type IssueEmail = Pick<EmailRecord, "status" | "error"> | { status: "not_configured"; error: string };

// Issuing never depends on the email: the invoice is issued first, then the email is tried and its result
// reported next to the invoice.
export const onRequestPost: PagesFunction<Env> = ({ request, env, params }) =>
  handle(async () => {
    const { account } = await requireUser(request, env);
    const now = new Date();
    const inv = await issueInvoice(env.DB, account, String(params.id), now.toISOString());
    if (!inv.data.clientEmail) return json(inv);
    let email: IssueEmail;
    try {
      const r = await sendInvoiceEmail({ db: env.DB, env, now, origin: publicOrigin(env, request.url) }, inv);
      email = { status: r.status, ...(r.error ? { error: r.error } : {}) };
    } catch (e) {
      if (e instanceof HttpError && e.message === NOT_CONFIGURED) email = { status: "not_configured", error: NOT_CONFIGURED };
      else {
        if (!(e instanceof HttpError)) console.error("invoice email failed");
        email = { status: "failed", error: e instanceof HttpError ? e.message : "The email could not be sent." };
      }
    }
    return json({ ...inv, email });
  });
