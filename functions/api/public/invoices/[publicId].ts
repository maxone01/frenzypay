import { chainReadConfig, createChainRpc, publicInvoiceFromChain } from "../../../../server/chain.ts";
import type { Env } from "../../../../server/env.ts";
import { HttpError, handle, json } from "../../../../server/http.ts";
import { getPublicInvoice } from "../../../../server/invoices.ts";

/** D1 first; a pay link D1 does not know is read from the public contract record when CONTRACT_ID is set. */
export const onRequestGet: PagesFunction<Env> = ({ env, params }) =>
  handle(async () => {
    const publicId = String(params.publicId);
    try {
      return json(await getPublicInvoice(env.DB, publicId));
    } catch (e) {
      const cfg = chainReadConfig(env);
      if (!(e instanceof HttpError) || e.status !== 404 || !cfg) throw e;
      const onChain = await publicInvoiceFromChain(cfg, createChainRpc(cfg.rpcUrl, (i, init) => fetch(i, init)), publicId);
      if (!onChain) throw e;
      return json(onChain);
    }
  });
