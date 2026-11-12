import { chainDeps, chainState, parseKind } from "../../../../server/chain.ts";
import type { Env } from "../../../../server/env.ts";
import { handle, json } from "../../../../server/http.ts";
import { requireUser } from "../../../../server/session.ts";

/** The record's on-chain status (settles pending writes and runs due mark-paid writes first). */
export const onRequestGet: PagesFunction<Env> = ({ request, env, params }) =>
  handle(async () => {
    const user = await requireUser(request, env);
    const kind = parseKind(params.kind);
    const deps = chainDeps(env);
    if (!deps) return json({ status: "off", canPublish: false });
    return json(await chainState(deps, user, kind, String(params.id)));
  });
