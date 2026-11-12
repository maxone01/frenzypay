import { chainDeps, parseKind, prepareChainWrite } from "../../../../../server/chain.ts";
import type { Env } from "../../../../../server/env.ts";
import { HttpError, handle, json, readJson } from "../../../../../server/http.ts";
import { requireUser } from "../../../../../server/session.ts";

/**
 * Start publishing (or retrying) a record: returns `{ state, sign? }`, where `sign` is the NEP-413 message the
 * owner's wallet must sign before `…/submit`. Body `{ action: "remove" }` prepares removing a payee.
 */
export const onRequestPost: PagesFunction<Env> = ({ request, env, params }) =>
  handle(async () => {
    const user = await requireUser(request, env);
    const kind = parseKind(params.kind);
    const deps = chainDeps(env);
    if (!deps) throw new HttpError(503, "On-chain records are turned off.");
    const body = (await readJson(request)) as { action?: unknown } | null;
    const action = body?.action === "remove" ? "remove" : undefined;
    return json(await prepareChainWrite(deps, user, kind, String(params.id), action));
  });
