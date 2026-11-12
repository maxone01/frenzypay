import { chainDeps, removePayeeOnChain, type SignedBody } from "../../../server/chain.ts";
import type { Env } from "../../../server/env.ts";
import { handle, json, readJson } from "../../../server/http.ts";
import { createPayee, deletePayee, listPayees } from "../../../server/payroll.ts";
import { requireUser } from "../../../server/session.ts";
import { transferDeps } from "../../../server/withdraw-deps.ts";

export const onRequestGet: PagesFunction<Env> = ({ request, env }) =>
  handle(async () => {
    const user = await requireUser(request, env);
    return json(await listPayees(transferDeps(env), user));
  });

export const onRequestPost: PagesFunction<Env> = ({ request, env }) =>
  handle(async () => {
    const user = await requireUser(request, env);
    return json(await createPayee(transferDeps(env), user, await readJson(request)), 201);
  });

/**
 * `DELETE /api/payroll/payees?id=<id>`: only the owner's own payee. An optional JSON body `{ chain: { nonce,
 * publicKey, signature } }` (signed for `remove_payee`) first removes the payee from the public contract;
 * that is best effort and its result is returned as `chain`, the payee is deleted either way.
 */
export const onRequestDelete: PagesFunction<Env> = ({ request, env }) =>
  handle(async () => {
    const user = await requireUser(request, env);
    const id = new URL(request.url).searchParams.get("id");
    const body = request.headers.get("content-type")?.includes("application/json") ? ((await readJson(request)) as { chain?: SignedBody } | null) : null;
    const deps = body?.chain ? chainDeps(env) : null;
    const chain = deps && typeof id === "string" ? await removePayeeOnChain(deps, user, id, body!.chain!) : undefined;
    await deletePayee(env.DB, user, id);
    return json({ ok: true, ...(chain ? { chain } : {}) });
  });
