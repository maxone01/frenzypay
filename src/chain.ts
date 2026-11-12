// On-chain public records in the browser: whether writes are on, the "On-chain" row on invoice, bill and
// payout pages, and publishing (the owner's NEAR wallet signs a NEP-413 message; the server relays it).
import { base64 } from "@scure/base";
import { escapeHTML as esc } from "../shared/text.ts";
import { api, postJson } from "./api.ts";
import { ensureWallet, signNep413, type Session } from "./wallet/index.ts";

export type ChainKind = "invoice" | "bill" | "payee" | "batch";
export type ChainStatus = "off" | "none" | "unpublished" | "pending" | "confirmed" | "failed" | "unavailable";
export type ChainView = {
  status: ChainStatus;
  network?: string;
  contractId?: string;
  synced?: string;
  tx?: string;
  txUrl?: string;
  error?: string;
  canPublish: boolean;
  lines?: { total: number; paid: number; pending: number; failed: number };
};
export type ChainConfig = { writes: boolean; network: string; contractId?: string };
type SignRequest = { action: string; payload: string; message: string; recipient: string; nonce: string };

/** Shown before anything is published: on mainnet the record can never be taken back. */
export const PUBLIC_NOTICE =
  "Why public: FrenzyPay records this on the NEAR blockchain. Names, line items and amounts become permanent and visible to anyone, and cannot be edited or deleted later. Client emails are never published.";

/**
 * sessionStorage key: the id of a bill or payout just created, so its page starts publishing right away (the
 * create form showed the public-record notice). Ignored when writes are off.
 */
export const PUBLISH_FLAG = "frenzypay:publish-after-create";
export function publishAfterCreate(id: string): void {
  try {
    sessionStorage.setItem(PUBLISH_FLAG, id);
  } catch {
    /* storage blocked: the page offers Publish instead */
  }
}

let config: Promise<ChainConfig> | null = null;
/** Cached for the page; any failure reads as "off" so the app never waits on the chain. */
export function chainConfig(): Promise<ChainConfig> {
  config ??= api<ChainConfig>("/api/chain/config").catch(() => ({ writes: false, network: "mainnet" }));
  return config;
}

export function publicNoticeHtml(id = "chain-notice"): string {
  return `<p class="fine chain-notice" id="${esc(id)}">${esc(PUBLIC_NOTICE)}</p>`;
}

/** Ask the wallet to sign what the server prepared, then submit it. */
async function signAndSend(path: string, sign: SignRequest): Promise<ChainView> {
  const session = await api<Session>("/api/me");
  await ensureWallet(session);
  const s = await signNep413({ message: sign.message, nonce: base64.decode(sign.nonce), recipient: sign.recipient });
  return postJson<ChainView>(`${path}/submit`, { nonce: sign.nonce, publicKey: s.publicKey, signature: s.signature });
}

/** Publish or retry the record's pending on-chain write. Resolves with the new state. */
export async function publishOnChain(kind: ChainKind, id: string): Promise<ChainView> {
  const path = `/api/chain/${kind}/${encodeURIComponent(id)}`;
  const r = await postJson<{ state: ChainView; sign?: SignRequest }>(`${path}/prepare`, {});
  return r.sign ? signAndSend(path, r.sign) : r.state;
}

/** Signed removal of a published payee, sent with the delete; null when it is not on-chain or writes are off. */
export async function payeeRemovalSignature(id: string): Promise<{ nonce: string; publicKey: string; signature: string } | null> {
  const r = await postJson<{ sign?: SignRequest }>(`/api/chain/payee/${encodeURIComponent(id)}/prepare`, { action: "remove" });
  if (!r.sign) return null;
  const session = await api<Session>("/api/me");
  await ensureWallet(session);
  const s = await signNep413({ message: r.sign.message, nonce: base64.decode(r.sign.nonce), recipient: r.sign.recipient });
  return { nonce: r.sign.nonce, ...s };
}

const LABEL: Record<Exclude<ChainStatus, "off">, string> = {
  none: "Not published",
  unpublished: "Not published yet",
  pending: "Pending",
  confirmed: "Recorded",
  failed: "Failed",
  unavailable: "Publishing needs a NEAR wallet sign-in",
};

/** The "On-chain" row: status, explorer link, and Publish/Retry when the owner can act. Empty when writes are off. */
export function chainRowHtml(v: ChainView | null | undefined, busy = false): string {
  if (v === undefined) return `<div class="chain-row" id="chain-row"><span class="eyebrow">On-chain</span><span class="muted" role="status">Checking…</span></div>`;
  if (!v || v.status === "off") return "";
  const update = v.status === "unpublished" && v.synced;
  let text = update ? "Latest change not published" : LABEL[v.status];
  if (v.status === "confirmed" && v.synced) text += ` (${v.synced})`;
  if (v.lines && v.lines.total) text += ` · ${v.lines.paid} of ${v.lines.total} lines marked paid`;
  const link = v.txUrl ? ` <a href="${esc(v.txUrl)}" target="_blank" rel="noopener noreferrer">View transaction</a>` : "";
  const action = v.canPublish
    ? `<button type="button" class="textbutton" id="chain-publish" ${busy ? "disabled" : ""}>${busy ? "Waiting for wallet…" : v.status === "failed" ? "Retry" : update ? "Publish update" : "Publish on-chain"}</button>`
    : "";
  const notice = v.status === "unpublished" ? publicNoticeHtml("chain-row-notice") : "";
  return `<div class="chain-row" id="chain-row"><span class="eyebrow">On-chain</span><span class="chain-state" role="status">${esc(text)}${link}</span>${action}${
    v.status === "failed" && v.error ? `<p class="error chain-error" role="alert">${esc(v.error)}</p>` : `<p class="error chain-error" role="alert"></p>`
  }${notice}</div>`;
}

/**
 * Fill `host` with the record's On-chain row and keep it current. With `autoPublish`, a record that needs the
 * owner's signature starts publishing right away (used straight after Issue). Returns a stop function.
 */
export function mountChainRow(host: HTMLElement, kind: ChainKind, id: string, opts: { autoPublish?: boolean } = {}): () => void {
  let alive = true;
  let state: ChainView | null | undefined;
  let busy = false;
  const draw = () => {
    if (!alive) return;
    host.innerHTML = chainRowHtml(state, busy);
    host.querySelector<HTMLButtonElement>("#chain-publish")?.addEventListener("click", () => void publish());
  };
  const publish = async () => {
    busy = true;
    draw();
    let error = "";
    try {
      state = await publishOnChain(kind, id);
    } catch (e) {
      error = e instanceof Error ? e.message : "Publishing failed.";
    }
    busy = false;
    draw();
    const err = host.querySelector(".chain-error");
    if (err && error) err.textContent = `${error} Your record is saved in FrenzyPay either way.`;
  };
  void (async () => {
    const cfg = await chainConfig();
    if (!alive) return;
    if (!cfg.writes) {
      host.innerHTML = "";
      return;
    }
    draw();
    try {
      state = await api<ChainView>(`/api/chain/${kind}/${encodeURIComponent(id)}`);
    } catch {
      state = { status: "failed", canPublish: true, error: "Could not read the on-chain status." };
    }
    draw();
    if (opts.autoPublish && state?.status === "unpublished") void publish();
  })();
  return () => {
    alive = false;
  };
}
