import { chainDeps, relayChain } from "../../../../server/chain.ts";
import type { Env } from "../../../../server/env.ts";
import { handle, json } from "../../../../server/http.ts";
import { getBatch } from "../../../../server/payroll.ts";
import { requireUser } from "../../../../server/session.ts";
import { transferDeps } from "../../../../server/withdraw-deps.ts";

/** The batch with every line's latest transfer, refreshed from NEAR Intents, and the derived summary. */
export const onRequestGet: PagesFunction<Env> = ({ request, env, params, waitUntil }) =>
  handle(async () => {
    const user = await requireUser(request, env);
    const view = await getBatch(transferDeps(env), user, String(params.id));
    const chain = chainDeps(env);
    if (chain && view.lines.some((l) => l.state === "sent")) waitUntil(relayChain(chain, user.account, "batch", view.batch.id));
    return json(view);
  });
