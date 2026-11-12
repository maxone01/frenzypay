// Wallet accounts the user already connected, offered as a destination or refund address.
// Every candidate is checked with the same validDestination() the forms are checked against, so an account
// is only ever offered for a chain whose address format it matches. Nothing here opens a wallet popup except
// the two explicit connect actions.
import { getAddress } from "viem";
import { validDestination } from "../../shared/address.ts";
import { evmAccounts, hasEvmProvider, requestEvmAccounts } from "./evm.ts";
import { connectNear, nearAccounts } from "./near.ts";
import type { Session } from "./index.ts";

export type ConnectedAccount = { label: string; address: string; source: "session" | "evm" | "near" };

/** A well-formed EVM address, used to ask shared/address.ts whether a chain is EVM without copying its chain list. */
const EVM_PROBE = "0x1111111111111111111111111111111111111111";
export const isEvmChain = (chain: string) => validDestination(chain, EVM_PROBE);

let signedIn: Session | null = null;
/** Accounts returned by "Connect another wallet", kept in case the wallet does not answer eth_accounts. */
const granted = new Set<string>();

/** Changes with the signed-in account; the chip row keys its cache on it. */
export const signedInKey = () => (signedIn ? `${signedIn.kind}:${signedIn.account}` : "");

/** Called by the app shell whenever the session changes. */
export function setSignedInAccount(s: Session | null): void {
  signedIn = s;
  if (!s) granted.clear();
}

const checksum = (a: string) => {
  try {
    return getAddress(a);
  } catch {
    return a;
  }
};

/** Short form for chip text: 0x12ab…89cd. Short names are shown whole. */
export function shortAddress(a: string): string {
  return a.length > 16 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export async function listConnectedAccounts(chain: string): Promise<ConnectedAccount[]> {
  const out: ConnectedAccount[] = [];
  const seen = new Set<string>();
  const add = (a: ConnectedAccount) => {
    const k = a.address.toLowerCase();
    if (seen.has(k) || !validDestination(chain, a.address)) return;
    seen.add(k);
    out.push(a);
  };
  const evm = isEvmChain(chain);
  if (signedIn) add({ label: "Signed-in account", address: signedIn.kind === "evm" ? checksum(signedIn.account) : signedIn.account, source: "session" });
  if (evm) {
    const all = [...new Set([...(await evmAccounts()), ...granted].map((a) => checksum(a)))];
    all.forEach((address, i) => add({ label: all.length > 1 ? `Browser wallet ${i + 1}` : "Browser wallet", address, source: "evm" }));
  } else if (chain === "near") {
    for (const a of await nearAccounts()) add({ label: a.walletName, address: a.accountId, source: "near" });
  }
  // Solana, Bitcoin, Tron and the rest: this app has no wallet connection for them, so nothing is offered.
  return out;
}

/** Which "Connect another wallet" actions make sense for a destination chain. */
export function connectActions(chain: string): ("evm" | "near")[] {
  if (isEvmChain(chain)) return hasEvmProvider() ? ["evm"] : [];
  return chain === "near" ? ["near"] : [];
}

/** Plain-language text for a failed wallet request. */
export function walletErrorText(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  if (code === 4001) return "You closed the wallet request. No account was added.";
  if (code === -32002) return "Your wallet already has a request open. Finish it in the wallet, then try again.";
  const m = e instanceof Error ? e.message : "";
  return m && m.length < 200 ? m : "The wallet did not connect. Try again.";
}

/** Asks the browser wallet for access (eth_requestAccounts). Never changes the signing account. */
export async function connectAnotherEvm(): Promise<string[]> {
  const accounts = await requestEvmAccounts();
  if (!accounts.length) throw new Error("The wallet did not return an account.");
  for (const a of accounts) granted.add(a.toLowerCase());
  return accounts;
}

/** Opens the NEAR wallet modal only to read the chosen wallet's accounts; the signing account stays as it was. */
export async function connectAnotherNear(): Promise<string> {
  return connectNear({ asSigner: false });
}
