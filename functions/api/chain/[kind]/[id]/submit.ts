import { chainDeps, parseKind, submitChainWrite, type SignedBody } from "../../../../../server/chain.ts";
import type { Env } from "../../../../../server/env.ts";
import { HttpError, handle, json, readJson } from "../../../../../server/http.ts";
import { requireUser } from "../../../../../server/session.ts";

/** `{ nonce, publicKey, signature }` from the wallet for the message `…/prepare` returned. */
export const onRequestPost: PagesFunction<Env> = ({ request, env, params }) =>
  handle(async () => {
    const user = await requireUser(request, env);
    const kind = parseKind(params.kind);
    const deps = chainDeps(env);
    if (!deps) throw new HttpError(503, "On-chain records are turned off.");
    return json(await submitChainWrite(deps, user, kind, String(params.id), (await readJson(request)) as SignedBody));
  });
