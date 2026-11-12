import { chainDeps, relayChain } from "../../../../server/chain.ts";
import type { Env } from "../../../../server/env.ts";
import { handle, json } from "../../../../server/http.ts";
import { oneClickFor } from "../../../../server/oneclick.ts";
import { ownerPayments } from "../../../../server/reconcile.ts";
import { requireUser } from "../../../../server/session.ts";

export const onRequestGet: PagesFunction<Env> = ({ request, env, params, waitUntil }) =>
  handle(async () => {
    const { account } = await requireUser(request, env);
    const oneclick = oneClickFor(env);
    const r = await ownerPayments({ db: env.DB, oneclick, now: new Date() }, account, String(params.id));
    const chain = chainDeps(env);
    if (chain && r.invoiceStatus === "paid") waitUntil(relayChain(chain, account, "invoice", String(params.id)));
    return json(r);
  });
