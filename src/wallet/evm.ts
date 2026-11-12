// Thin EIP-1193 adapter over the injected `window.ethereum`. EOAs only: the server verifies
// signatures with ecrecover, so smart-contract (EIP-1271) wallets cannot sign in.
import { addChainParams, chainById, type EvmPayPlan } from "../../shared/wallet-pay.ts";

export type Eip1193Provider = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };

let current: string | null = null;

function provider(): Eip1193Provider {
  const p = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
  if (!p || typeof p.request !== "function") throw new Error("No EVM wallet found. Install or enable a browser wallet such as MetaMask.");
  return p;
}

function utf8Hex(s: string): string {
  return "0x" + Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function connectEvm(): Promise<string> {
  const accounts = (await provider().request({ method: "eth_requestAccounts" })) as unknown;
  const first = Array.isArray(accounts) ? accounts[0] : undefined;
  if (typeof first !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(first)) throw new Error("The wallet did not return an account.");
  current = first.toLowerCase();
  return current;
}

/** ERC-191 `personal_sign` of a UTF-8 message with the connected account. */
export async function signErc191(message: string): Promise<string> {
  if (!current) throw new Error("Connect an EVM wallet first.");
  const sig = await provider().request({ method: "personal_sign", params: [utf8Hex(message), current] });
  if (typeof sig !== "string" || !/^0x[0-9a-fA-F]+$/.test(sig)) throw new Error("The wallet returned an invalid signature.");
  return sig;
}

export function hasEvmProvider(): boolean {
  const p = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
  return !!p && typeof p.request === "function";
}

const addressList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((a): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a)) : []);

/** Accounts the wallet already exposes to this site (`eth_accounts`: never opens a popup). */
export async function evmAccounts(): Promise<string[]> {
  if (!hasEvmProvider()) return [];
  try {
    return addressList(await provider().request({ method: "eth_accounts" }));
  } catch {
    return [];
  }
}

/** Ask the wallet to expose accounts (`eth_requestAccounts`). Does not change the signing account. */
export async function requestEvmAccounts(): Promise<string[]> {
  return addressList(await provider().request({ method: "eth_requestAccounts" }));
}

const errorCode = (e: unknown): unknown => {
  const err = e as { code?: unknown; data?: { originalError?: { code?: unknown } } } | null;
  return err?.code ?? err?.data?.originalError?.code;
};

const chainIdOf = async (p: Eip1193Provider): Promise<number> => {
  const v = await p.request({ method: "eth_chainId" });
  return typeof v === "string" ? Number.parseInt(v, 16) : typeof v === "number" ? v : NaN;
};

/** Put the wallet on `chainId`: switch, or add the chain first when the wallet does not know it (4902). */
async function ensureChain(p: Eip1193Provider, chainId: number): Promise<void> {
  if ((await chainIdOf(p)) === chainId) return;
  const hex = `0x${chainId.toString(16)}`;
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e) {
    if (errorCode(e) !== 4902) throw e;
    await p.request({ method: "wallet_addEthereumChain", params: [addChainParams(chainId)] });
    if ((await chainIdOf(p)) !== chainId) await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  }
  if ((await chainIdOf(p)) !== chainId) throw new Error(`Switch your wallet to ${chainById(chainId)?.name ?? `chain ${chainId}`} and try again. Nothing was sent.`);
}

/**
 * Send one payment exactly as planned: ask for an account, move the wallet to the plan's chain, then
 * eth_sendTransaction (native value to the deposit address, or ERC-20 transfer calldata to the token).
 * The wallet shows the transaction and the payer approves or rejects it there. Returns the tx hash.
 */
export async function payEvm(plan: EvmPayPlan): Promise<string> {
  const p = provider();
  const from = addressList(await p.request({ method: "eth_requestAccounts" }))[0];
  if (!from) throw new Error("The wallet did not return an account.");
  await ensureChain(p, plan.chainId);
  const tx: Record<string, string> = { from, to: plan.to, value: plan.value };
  if (plan.data) tx.data = plan.data;
  const hash = await p.request({ method: "eth_sendTransaction", params: [tx] });
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("The wallet did not return a transaction hash. Check your wallet's activity before paying again.");
  return hash;
}

export function evmConnectedAccount(): string | null {
  return current;
}

export function disconnectEvm(): void {
  current = null;
}
