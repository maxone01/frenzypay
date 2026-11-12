// "Use a connected wallet" row under an address input. Views render walletPickHtml() right after the input
// and call wireWalletPick() once the template is in the DOM. A chip only fills the input on click; the view's
// own validation, review step and confirmation are untouched.
import { escapeHTML as esc } from "../../shared/text.ts";
import {
  connectActions, connectAnotherEvm, connectAnotherNear, listConnectedAccounts, shortAddress, signedInKey, walletErrorText, type ConnectedAccount,
} from "../wallet/accounts.ts";

export type WalletPickOptions = {
  /** id of the address <input>; the row gets `${inputId}-wallets`. */
  inputId: string;
  /** Destination chain code (eth, arb, near, sol, …). */
  chain: string;
};

/** Last list per chain, so a view redraw shows the chips straight away instead of flickering. */
const cache = new Map<string, ConnectedAccount[]>();
const key = (o: WalletPickOptions) => `${o.chain}|${signedInKey()}`;

function rowInner(o: WalletPickOptions, accounts: ConnectedAccount[]): string {
  const actions = connectActions(o.chain);
  if (!accounts.length && !actions.length) return "";
  const title = `${o.inputId}-wallets-title`;
  const chips = accounts
    .map(
      (a) =>
        `<button type="button" class="wallet-chip" data-address="${esc(a.address)}" data-label="${esc(a.label)}" title="${esc(a.address)}" aria-label="Use ${esc(a.label)}: ${esc(a.address)}"><span>${esc(a.label)}</span><code>${esc(shortAddress(a.address))}</code></button>`,
    )
    .join("");
  const another = accounts.length ? "another " : "a ";
  const connect = actions.includes("evm")
    ? `<button type="button" class="textbutton wallet-connect" data-connect="evm">Connect ${another}wallet</button>`
    : actions.includes("near")
      ? `<button type="button" class="textbutton wallet-connect" data-connect="near">Connect ${another}NEAR wallet</button>`
      : "";
  return `${accounts.length ? `<p class="wallet-pick-title" id="${esc(title)}">Use a connected wallet</p>` : ""}<div class="wallet-pick-list"${accounts.length ? ` role="group" aria-labelledby="${esc(title)}"` : ""}>${chips}${connect}</div>
<p class="fine wallet-pick-status" role="status"></p><p class="error wallet-pick-error" role="alert"></p>`;
}

export function walletPickHtml(o: WalletPickOptions): string {
  return `<div class="wallet-pick" id="${esc(o.inputId)}-wallets">${rowInner(o, cache.get(key(o)) ?? [])}</div>`;
}

export function wireWalletPick(root: ParentNode, o: WalletPickOptions): void {
  const box = root.querySelector<HTMLElement>(`#${o.inputId}-wallets`);
  if (!box) return;
  let accounts = cache.get(key(o)) ?? [];

  const render = () => {
    if (!box.isConnected) return;
    box.innerHTML = rowInner(o, accounts);
  };
  const say = (status: string, error = "") => {
    const s = box.querySelector(".wallet-pick-status");
    const e = box.querySelector(".wallet-pick-error");
    if (s) s.textContent = status;
    if (e) e.textContent = error;
  };
  const refresh = async () => {
    const next = await listConnectedAccounts(o.chain);
    cache.set(key(o), next);
    if (!box.isConnected) return;
    const changed = JSON.stringify(next) !== JSON.stringify(accounts);
    accounts = next;
    if (changed) render();
  };

  box.addEventListener("click", async (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (!btn || !box.contains(btn)) return;
    const address = btn.dataset.address;
    if (address) {
      const input = root.querySelector<HTMLInputElement>(`#${o.inputId}`);
      if (!input || input.disabled) return;
      input.value = address;
      // The view keeps its form state from the input event, exactly as if the address had been typed.
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
      say(`Filled with ${btn.dataset.label ?? "the wallet"} address. Check it before you continue.`);
      return;
    }
    const kind = btn.dataset.connect;
    if (kind !== "evm" && kind !== "near") return;
    btn.disabled = true;
    say("Waiting for your wallet…");
    try {
      if (kind === "evm") await connectAnotherEvm();
      else await connectAnotherNear();
      const before = accounts.length;
      await refresh();
      render();
      say(accounts.length > before ? "Wallet connected. Pick an address above." : "No new address for this network.");
    } catch (e) {
      btn.disabled = false;
      say("", walletErrorText(e));
    }
  });

  void refresh().catch(() => {
    /* nothing to offer; the plain input still works */
  });
}
