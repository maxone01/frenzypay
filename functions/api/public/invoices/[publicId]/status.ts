import { chainDeps, relayChain } from "../../../../../server/chain.ts";
import type { Env } from "../../../../../server/env.ts";
import { handle, json } from "../../../../../server/http.ts";
import { getInvoiceByPublicId } from "../../../../../server/invoices.ts";
import { oneClickFor } from "../../../../../server/oneclick.ts";
import { publicStatus } from "../../../../../server/reconcile.ts";

export const onRequestGet: PagesFunction<Env> = ({ env, params, waitUntil }) =>
  handle(async () => {
    const oneclick = oneClickFor(env);
    const publicId = String(params.publicId);
    const r = await publicStatus({ db: env.DB, oneclick, now: new Date() }, publicId);
    const chain = chainDeps(env);
    // Payment confirmed: the relayer marks the public record paid after the response (never blocks the payer).
    if (chain && r.invoiceStatus === "paid")
      waitUntil(getInvoiceByPublicId(env.DB, publicId).then((inv) => relayChain(chain, inv.owner, "invoice", inv.id)).catch(() => {}));
    return json(r);
  });
