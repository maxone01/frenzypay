import { chainConfig, networkOf } from "../../../server/chain.ts";
import type { Env } from "../../../server/env.ts";
import { handle, json } from "../../../server/http.ts";

/** Whether on-chain writes are on, so the app shows the public-record notice and publish controls. No secrets. */
export const onRequestGet: PagesFunction<Env> = ({ env }) =>
  handle(async () => {
    const cfg = chainConfig(env);
    return json(cfg ? { writes: true, network: cfg.network, contractId: cfg.contractId } : { writes: false, network: networkOf(env) });
  });
