import { emailState, publicOrigin, sendInvoiceEmail } from "../../../../server/email.ts";
import type { Env } from "../../../../server/env.ts";
import { handle, json } from "../../../../server/http.ts";
import { getInvoice } from "../../../../server/invoices.ts";
import { requireUser } from "../../../../server/session.ts";

/** Whether email is configured, and the last email for this invoice. Owner only. */
export const onRequestGet: PagesFunction<Env> = ({ request, env, params }) =>
  handle(async () => {
    const { account } = await requireUser(request, env);
    const inv = await getInvoice(env.DB, account, String(params.id));
    return json(await emailState(env.DB, env, inv.id));
  });

/** Send or resend the payment link to the invoice's stored client email. Owner only; no body. */
export const onRequestPost: PagesFunction<Env> = ({ request, env, params }) =>
  handle(async () => {
    const { account } = await requireUser(request, env);
    const inv = await getInvoice(env.DB, account, String(params.id));
    const now = new Date();
    return json(await sendInvoiceEmail({ db: env.DB, env, now, origin: publicOrigin(env, request.url) }, inv));
  });
