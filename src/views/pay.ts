import { supportedChain } from "../../shared/address.ts";
import type { PublicInvoice } from "../../shared/invoice.ts";
import { escapeHTML as esc } from "../../shared/text.ts";
import { api } from "../api.ts";
import { details } from "./invoice-detail.ts";
import { txLinks } from "./invoices.ts";
import { routeHtml } from "./transfer-ui.ts";
import { comboboxHtml, wireCombobox, type ComboOptions } from "../ui/combobox.ts";
import { walletPickHtml, wireWalletPick } from "../ui/wallet-pick.ts";
import { chainName, tokenItem } from "./withdraw.ts";
import { EVM_CHAINS, eip681, payPlan, type PayPlan, type PayToken } from "../../shared/wallet-pay.ts";
import { hasEvmProvider, payEvm } from "../wallet/evm.ts";
import { payNear } from "../wallet/near.ts";

type Token = PayToken;
type Attempt = {
  symbol: string; blockchain: string;
  depositAddress: string; depositMemo?: string; originAsset: string; amountIn: string; amountInFormatted: string;
  deadline: string; status: string; outcome?: string; expired: boolean; destinationTxHashes?: string[];
};
type StatusResponse = { invoiceStatus: PublicInvoice["status"]; attempts: Attempt[]; refreshError?: string };

const POLL_MS = 10_000;
const OPEN = new Set(["PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "INCOMPLETE_DEPOSIT", "PROCESSING", "SUCCESS"]);
/** Still waiting on 1Click: no recorded outcome and not an expired, unfunded quote. */
const active = (a: Attempt) => !a.outcome && !a.expired && OPEN.has(a.status);
/** Funds were seen; instructions are no longer needed. */
const settling = (a: Attempt) => a.status === "KNOWN_DEPOSIT_TX" || a.status === "PROCESSING" || a.status === "SUCCESS";

const MISMATCH = "This payment could not be matched to the invoice. Contact the business before paying again.";
const EXTRA = "Your payment was received by the business as an extra payment. Contact them to arrange a refund.";
/** Notice for the payer's own attempt once it has an outcome that is not a plain paid/refunded/failed. */
const ownNotice = (a: Attempt | undefined) =>
  a?.outcome === "mismatch" ? MISMATCH : a?.outcome === "duplicate" || a?.outcome === "after_cancel" ? EXTRA : "";

const post = <T>(path: string, body: unknown) => api<T>(path, { method: "POST", body: JSON.stringify(body) });

function store(key: string, v?: Attempt | null): Attempt | null {
  try {
    if (v === undefined) return JSON.parse(sessionStorage.getItem(key) ?? "null") as Attempt | null;
    if (v === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
  return null;
}

function readDismissed(key: string): Set<string> {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(key) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

/** Plain text for a wallet that did not send. Only a clear rejection may say "Nothing was sent". */
export function payErrorText(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  const msg = e instanceof Error ? e.message : "";
  if (code === 4001 || /user rejected|user denied|rejected by user/i.test(msg)) return "You declined in your wallet. Nothing was sent.";
  if (code === -32002) return "Your wallet already has a request open. Finish or close it in the wallet, then try again.";
  if (msg && msg.length < 200) return msg;
  return "The wallet did not confirm the payment. Check your wallet's activity before trying again, or copy the address and amount below.";
}

/** Review sentence shown above the button: exactly what the wallet will be asked to send. */
export function reviewHtml(plan: PayPlan, a: { amountInFormatted: string; symbol: string; blockchain: string }): string {
  const amount = `<strong>${esc(a.amountInFormatted)} ${esc(a.symbol)}</strong>`;
  if (plan.kind === "evm") {
    const via = plan.asset === "erc20" ? ` (token contract <code>${esc(plan.token!)}</code>)` : "";
    return `Your wallet will ask you to send exactly ${amount}${via} on <strong>${esc(EVM_CHAINS[plan.chain].name)}</strong> (chain ${plan.chainId}) to <code>${esc(plan.depositAddress)}</code>. Nothing is sent until you approve it there.`;
  }
  const wrap = plan.wrapNative ? ` Your wallet wraps that much native NEAR into wNEAR and sends it in the same transaction.` : "";
  return `Your NEAR wallet will ask you to send exactly ${amount} (token <code>${esc(plan.contract)}</code>) on <strong>NEAR</strong> to <code>${esc(plan.depositAddress)}</code>.${wrap} Up to ${plan.wrapNative ? "0.0025" : "0.00125"} NEAR is attached for token storage and refunded when not needed. Nothing is sent until you approve it there.`;
}

function countdown(deadline: string, now = Date.now()): string {
  const s = Math.max(0, Math.floor((new Date(deadline).getTime() - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function mountPay(el: HTMLElement, params: Record<string, string>): () => void {
  let alive = true;
  let timer = 0;
  let pollTimer = 0;
  const publicId = params.publicId;
  const key = `frenzypay:pay:${publicId}`;
  const base = `/api/public/invoices/${encodeURIComponent(publicId)}`;
  let inv: PublicInvoice | null = null;
  let tokens: Token[] = [];
  let attempt: Attempt | null = null;
  let attempts: Attempt[] = [];
  let notice = "";
  /** About this browser's own attempt; shown on every panel, including paid and cancelled. */
  let own = "";
  const dismissedKey = `${key}:dismissed`;
  const dismissed = readDismissed(dismissedKey);
  let error = "";
  let busy = false;
  let chosen = "";
  let refund = "";
  /** Deposit address → tx hash this browser's wallet sent to it. Kept so a reload never offers to pay twice. */
  const sentKey = `${key}:sent`;
  const sent: Record<string, string> = (() => {
    try {
      const v = JSON.parse(sessionStorage.getItem(sentKey) ?? "{}") as unknown;
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : {};
    } catch {
      return {};
    }
  })();
  const saveSent = () => {
    try {
      sessionStorage.setItem(sentKey, JSON.stringify(sent));
    } catch {
      /* storage unavailable */
    }
  };
  let walletBusy = false;
  let walletError = "";
  let depositNote = "";

  el.innerHTML = `<p class="muted" role="status">Loading…</p>`;

  const tokenOf = (id: string) => tokens.find((t) => t.assetId === id);

  function draw() {
    window.clearInterval(timer);
    if (!inv) {
      el.innerHTML = `<div class="heading"><div><h1>Invoice unavailable</h1><p class="error" role="alert">${esc(error)}</p></div></div>`;
      return;
    }
    const head = `<div class="heading"><div><p class="eyebrow">Invoice ${esc(inv.data.number)}</p><h1>Pay ${esc(inv.totalFormatted)} ${esc(inv.symbol)}</h1><p class="muted">Paid to ${esc(inv.payTo)} on NEAR Intents</p></div></div>`;
    const summary = `<section class="panel">${details(inv.data)}</section>`;
    const ownAlert = own ? `<p class="error" role="alert">${esc(own)}</p>` : "";
    let body = "";
    if (inv.status === "paid") body = paid(ownAlert);
    else if (inv.status === "cancelled") body = `<section class="panel"><h2>Cancelled</h2>${ownAlert}<p class="muted">This invoice was cancelled and can no longer be paid.</p></section>`;
    // Only the public on-chain record exists here (no FrenzyPay copy to take payment against).
    else if (inv.source === "chain")
      body = `<section class="panel" id="pay-chain-only"><h2>Public record only</h2><p class="muted">This invoice was read from its public record on the NEAR blockchain. It cannot be paid through this page; ask the sender for a current payment link.</p></section>`;
    else if (attempt && active(attempt))
      body = settling(attempt) || (attempt.status === "PENDING_DEPOSIT" && sent[attempt.depositAddress]) ? processing(attempt) : instructions(attempt);
    else body = form(attempt?.expired ?? false);
    el.innerHTML = `${head}${summary}${body}`;
    wire();
  }

  function paid(ownAlert: string): string {
    const hashes = attempts.find((a) => a.outcome === "paid")?.destinationTxHashes ?? [];
    return `<section class="panel"><h2>Paid — thank you</h2>${ownAlert}<p class="muted">This invoice is paid in full. There is nothing more to send.</p>${hashes.length ? `<p class="fine">Settlement on NEAR: ${txLinks(hashes)}</p>` : ""}</section>`;
  }

  function processing(a: Attempt): string {
    const hash = sent[a.depositAddress];
    const text =
      a.status === "PENDING_DEPOSIT" && hash
        ? `Your wallet sent the payment${a.amountInFormatted ? ` of ${esc(a.amountInFormatted)} ${esc(a.symbol)}` : ""}. It is matched once the transaction confirms${a.blockchain ? ` on ${esc(chainName(a.blockchain))}` : ""}, then settled. This usually takes a few minutes. Do not pay again; you can keep this page open.`
        : `Your deposit${a.amountInFormatted ? ` of ${esc(a.amountInFormatted)} ${esc(a.symbol)}` : ""} was received and is being settled. This usually takes a few minutes. You can keep this page open.`;
    return `<section class="panel pay-instructions"><div class="section-title"><h2>Processing</h2></div><p class="muted" role="status">${text}</p>${
      hash ? `<div class="pay-field"><span class="eyebrow">Your transaction</span><code id="pay-tx">${esc(hash)}</code></div>` : ""
    }${depositNote ? `<p class="fine">${esc(depositNote)}</p>` : ""}</section>`;
  }

  /** "Pay with wallet" block, or a plain note when this chain/token has no one-click path here. */
  function walletBlock(a: Attempt): string {
    if (a.status !== "PENDING_DEPOSIT" || !a.amountIn) return "";
    const plan = payPlan(tokenOf(a.originAsset), a.depositAddress, a.amountIn, a.depositMemo);
    if (!plan) return `<p class="fine pay-wallet-alt">Paying from a connected wallet is not available for this token on ${esc(chainName(a.blockchain))} yet. Copy the address and exact amount below into your wallet.</p>`;
    const injected = plan.kind === "near" || hasEvmProvider();
    const button = injected
      ? `<button class="primary" type="button" id="pay-wallet" ${walletBusy ? "disabled" : ""}>${plan.kind === "near" ? "Pay with NEAR wallet" : "Pay with wallet"}</button>`
      : `<p class="fine">No browser wallet found on this device.</p>`;
    const mobile = plan.kind === "evm" ? `<p class="fine pay-wallet-alt"><a href="${esc(eip681(plan))}" id="pay-eip681">Open in a mobile wallet</a> (EIP-681 link; check the amount and network before you approve).</p>` : "";
    return `<div class="pay-wallet"><p id="pay-wallet-review">${reviewHtml(plan, a)}</p>${button}${mobile}<p class="fine pay-wallet-status" id="pay-wallet-status" role="status">${walletBusy ? "Confirm the payment in your wallet…" : ""}</p><p class="error pay-wallet-error" id="pay-wallet-error" role="alert">${esc(walletError)}</p></div>`;
  }

  const tokenBox = (): ComboOptions => ({
    id: "pay-token", label: "Token", items: tokens.filter((t) => supportedChain(t.blockchain)).map(tokenItem), value: chosen,
    placeholder: "Search token or chain, e.g. USDC or arb",
    onChange: (v) => {
      chosen = v;
      refund = el.querySelector<HTMLInputElement>("#pay-refund")!.value;
      error = "";
      draw();
      if (v) el.querySelector<HTMLInputElement>("#pay-refund")?.focus();
    },
  });

  function form(expired: boolean): string {
    const t = tokenOf(chosen);
    return `<section class="panel"><div class="section-title"><h2>Pay with</h2></div>${expired ? `<p class="error" role="alert">Your previous payment instructions expired. Do not send funds to the old address. Get new instructions below.</p>` : notice ? `<p class="error" role="alert">${esc(notice)}</p>` : ""}<form id="pay-form" novalidate>
${comboboxHtml(tokenBox())}
<label>${t ? `Refund address on ${esc(t.blockchain)}` : "Refund address"}<input id="pay-refund" autocomplete="off" spellcheck="false" value="${esc(refund)}" ${t ? "" : "disabled"}></label>
${t ? walletPickHtml({ inputId: "pay-refund", chain: t.blockchain }) : ""}
<p class="fine">If the payment cannot complete, your funds are returned to this address on the chain you pay from. Double-check it.</p>
<p class="error" id="pay-error" role="alert">${esc(error)}</p>
<button class="primary" type="submit" ${busy ? "disabled" : ""}>Get payment instructions</button></form></section>`;
  }

  function instructions(a: Attempt): string {
    const done = a.status !== "PENDING_DEPOSIT";
    return `<section class="panel pay-instructions"><div class="section-title"><h2>Send payment</h2></div>
${a.amountInFormatted ? `<p class="invoice-total"><span>Send exactly</span><strong id="pay-amount">${esc(a.amountInFormatted)} ${esc(a.symbol)}</strong></p>
<p class="muted">on ${esc(a.blockchain)} <button class="textbutton" type="button" data-copy="${esc(a.amountInFormatted)}">Copy amount</button></p>
${inv ? routeHtml([{ symbol: a.symbol, where: chainName(a.blockchain) }, { symbol: inv.symbol, where: "NEAR Intents" }]) : ""}
${a.depositAddress ? walletBlock(a) : ""}` : `<p class="error" role="alert">The amount for these instructions is unavailable right now. Do not send funds until it is shown. Reload to try again.</p>`}
${a.status === "INCOMPLETE_DEPOSIT" ? `<p class="error" role="alert">The deposit received is less than required. Send the remaining amount before the deadline, or it will be refunded.</p>` : ""}
<div class="pay-field"><span class="eyebrow">Deposit address</span><code id="pay-address">${esc(a.depositAddress)}</code><button class="textbutton" type="button" data-copy="${esc(a.depositAddress)}">Copy address</button></div>
${a.depositMemo ? `<div class="pay-field"><span class="eyebrow">Memo (required)</span><code id="pay-memo">${esc(a.depositMemo)}</code><button class="textbutton" type="button" data-copy="${esc(a.depositMemo)}">Copy memo</button></div>` : ""}
<p class="fine">Send exactly this amount from the selected chain. Unused amount is refunded to your refund address.</p>
${done ? `<p class="muted" role="status">Status: ${esc(a.status.replaceAll("_", " ").toLowerCase())}</p>` : `<p class="muted" role="status">Expires in <strong id="pay-countdown">${esc(countdown(a.deadline))}</strong></p>`}
<details><summary>I've sent it</summary><form id="tx-form" novalidate><label>Transaction hash<input id="tx-hash" autocomplete="off" spellcheck="false"></label><p class="error" id="tx-error" role="alert"></p><p class="fine" id="tx-ok" role="status"></p><button class="textbutton" type="submit">Submit transaction hash</button></form></details>
<button class="textbutton" type="button" id="pay-restart">Start over</button></section>`;
  }

  function wire() {
    const q = <T extends HTMLElement>(s: string) => el.querySelector<T>(s);
    if (q("#pay-form")) {
      wireCombobox(el, tokenBox());
      const t = tokenOf(chosen);
      if (t) wireWalletPick(el, { inputId: "pay-refund", chain: t.blockchain });
    }
    q<HTMLFormElement>("#pay-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      refund = q<HTMLInputElement>("#pay-refund")!.value.trim();
      if (!chosen) return fail("Choose a token to pay with.");
      if (!refund) return fail("Enter a refund address.");
      busy = true;
      error = "";
      draw();
      try {
        attempt = await post<Attempt>(`${base}/quote`, { originAsset: chosen, refundTo: refund });
        attempts = [attempt, ...attempts.filter((a) => a.depositAddress !== attempt!.depositAddress)];
        notice = "";
        own = "";
        store(key, attempt);
      } catch (err) {
        error = (err as Error).message;
      }
      busy = false;
      if (alive) {
        draw();
        schedule();
      }
    });
    el.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((b) => {
      b.onclick = async () => {
        try {
          await navigator.clipboard.writeText(b.dataset.copy!);
          b.textContent = "Copied";
        } catch {
          b.textContent = "Copy failed. Select the text instead.";
        }
      };
    });
    q<HTMLButtonElement>("#pay-wallet")?.addEventListener("click", () => void payFromWallet());
    q("#pay-restart")?.addEventListener("click", () => {
      if (attempt) {
        dismissed.add(attempt.depositAddress);
        try {
          sessionStorage.setItem(dismissedKey, JSON.stringify([...dismissed].slice(-20)));
        } catch {
          /* storage unavailable */
        }
      }
      attempt = null;
      store(key, null);
      draw();
    });
    q<HTMLFormElement>("#tx-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const hash = q<HTMLInputElement>("#tx-hash")!.value.trim();
      q("#tx-error")!.textContent = "";
      q("#tx-ok")!.textContent = "";
      if (!hash) {
        q("#tx-error")!.textContent = "Paste your transaction hash.";
        return;
      }
      try {
        await post(`${base}/deposit`, { depositAddress: attempt!.depositAddress, txHash: hash });
        if (alive) q("#tx-ok")!.textContent = "Thanks. We will match it as soon as it confirms.";
      } catch (err) {
        if (alive) q("#tx-error")!.textContent = (err as Error).message;
      }
    });
    const cd = q("#pay-countdown");
    if (cd && attempt) {
      timer = window.setInterval(() => {
        if (!attempt) return;
        if (new Date(attempt.deadline).getTime() <= Date.now()) {
          attempt = { ...attempt, expired: true, depositAddress: "", depositMemo: undefined };
          store(key, null);
          draw();
        } else cd.textContent = countdown(attempt.deadline);
      }, 1000);
    }
  }

  /** Only ever called from the Pay button. The wallet shows the transaction and the payer approves it there. */
  async function payFromWallet() {
    const a = attempt;
    if (!a || walletBusy || sent[a.depositAddress] || a.status !== "PENDING_DEPOSIT" || a.expired) return;
    const token = tokenOf(a.originAsset);
    const plan = payPlan(token, a.depositAddress, a.amountIn, a.depositMemo);
    if (!plan || !token) return;
    walletBusy = true;
    walletError = "";
    draw();
    let hash: string;
    try {
      hash = plan.kind === "evm" ? await payEvm(plan) : (await payNear(token, plan.depositAddress, plan.amount)).txHash;
    } catch (e) {
      walletBusy = false;
      walletError = payErrorText(e);
      if (alive) draw();
      return;
    }
    walletBusy = false;
    sent[a.depositAddress] = hash;
    saveSent();
    depositNote = "";
    if (alive) draw();
    try {
      await post(`${base}/deposit`, { depositAddress: a.depositAddress, txHash: hash });
    } catch {
      // The deposit is still found on chain without this hint; it only speeds up matching.
      depositNote = "We could not pass the transaction to the payment network just now. It is still detected on chain; no need to pay again.";
    }
    if (alive) {
      draw();
      schedule();
    }
  }

  function fail(msg: string) {
    error = msg;
    const box = el.querySelector("#pay-error");
    if (box) box.textContent = msg;
  }

  /** Keep display fields we already have when the server cannot format them (e.g. token list unavailable). */
  function merge(prev: Attempt | null | undefined, next: Attempt): Attempt {
    if (!prev || prev.depositAddress !== next.depositAddress || next.amountInFormatted) return next;
    return { ...next, amountInFormatted: prev.amountInFormatted, symbol: prev.symbol, blockchain: prev.blockchain };
  }

  /** Apply a status response. Picks the newest open attempt on first load; afterwards only follows the current one. */
  function apply(st: StatusResponse, initial: boolean) {
    attempts = st.attempts;
    if (inv) inv = { ...inv, status: st.invoiceStatus };
    if (initial) {
      const saved = store(key);
      own = ownNotice(st.attempts.find((a) => a.depositAddress === saved?.depositAddress));
      const cur = st.attempts.find((a) => active(a) && !dismissed.has(a.depositAddress));
      attempt = cur ? merge(saved, cur) : null;
      // Keep it while it explains this browser's own payment, so the notice survives a reload.
      if (!attempt && saved && !own) store(key, null);
      const latest = st.attempts.find((a) => !dismissed.has(a.depositAddress));
      if (!attempt && latest?.outcome === "refunded") notice = "Your last payment was refunded to your refund address. You can try again below.";
      else if (!attempt && latest?.outcome === "failed") notice = "Your last payment could not be completed. Any funds are returned to your refund address.";
      else if (!attempt && latest?.outcome === "mismatch") notice = MISMATCH;
      if (own) notice = own;
    } else if (attempt) {
      const cur = st.attempts.find((a) => a.depositAddress === attempt!.depositAddress);
      if (cur) {
        attempt = merge(attempt, cur);
        if (cur.outcome === "refunded") notice = "Your payment was refunded to your refund address. You can try again below.";
        else if (cur.outcome === "failed") notice = "Your payment could not be completed. Any funds are returned to your refund address.";
        own = ownNotice(cur);
        if (own) notice = own;
        if (!active(attempt) && !own) store(key, null);
      }
    }
  }

  const signature = () =>
    JSON.stringify([inv?.status, attempt?.status, attempt?.outcome, attempt?.expired, attempt?.amountInFormatted, notice, own, attempts.find((a) => a.outcome === "paid")?.destinationTxHashes]);

  function schedule() {
    window.clearTimeout(pollTimer);
    if (!alive || inv?.status !== "issued" || !attempts.some(active)) return;
    pollTimer = window.setTimeout(poll, POLL_MS);
  }

  async function poll() {
    const st = await api<StatusResponse>(`${base}/status`).catch(() => null);
    if (!alive) return;
    if (st) {
      const before = signature();
      apply(st, false);
      if (signature() !== before) draw();
    }
    schedule();
  }

  void (async () => {
    try {
      const [i, t, st] = await Promise.all([
        api<PublicInvoice>(base),
        api<Token[]>("/api/tokens").catch(() => [] as Token[]),
        api<StatusResponse>(`${base}/status`).catch(() => null),
      ]);
      if (!alive) return;
      inv = i;
      if (i.source === "chain") {
        draw();
        return;
      }
      tokens = t;
      if (st) apply(st, true);
      else {
        // Status unavailable: fall back to the instructions this browser last saw.
        const saved = store(key);
        if (saved && new Date(saved.deadline).getTime() > Date.now() && saved.status === "PENDING_DEPOSIT") {
          attempt = saved;
          attempts = [saved];
        } else if (saved) store(key, null);
      }
      if (!tokens.length && inv.status === "issued") error = "Could not load the list of tokens. Reload to try again.";
    } catch (e) {
      error = (e as Error).message;
    }
    if (alive) {
      draw();
      schedule();
    }
  })();

  return () => {
    alive = false;
    window.clearInterval(timer);
    window.clearTimeout(pollTimer);
  };
}
