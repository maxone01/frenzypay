import { postJson } from "../api.ts";
import { connectEvm, disconnectEvm, evmConnectedAccount, signErc191 } from "./evm.ts";
import { connectNear, disconnectNear, nearConnectedAccount, nearPublicKey, registerIntentsKey, restoreNear, signNep413 } from "./near.ts";

export type Kind = "near" | "evm";
export type Session = { account: string; kind: Kind };
export { nearPublicKey, registerIntentsKey, signErc191, signNep413 };

/** Connect a wallet. NEAR opens the connector's wallet modal; `expectNear` reuses a restored wallet for that account. */
export async function connectWallet(kind: Kind, expectNear?: string): Promise<Session> {
  const account = kind === "evm" ? await connectEvm() : await connectNear({ expect: expectNear });
  return { account, kind };
}

/** After a reload, reconnect the NEAR wallet the signed-in user picked last time (no popup). */
export function restoreWallet(s: Session | null): void {
  if (s?.kind === "near") void restoreNear();
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** Full sign-in: connect wallet, fetch a challenge, sign it, and exchange it for a session cookie. */
export async function signIn(kind: Kind): Promise<Session> {
  const { account } = await connectWallet(kind);
  const ch = await postJson<{ nonce: string; message: string; recipient: string }>("/api/auth/challenge", { kind, account });
  const body =
    kind === "evm"
      ? { kind, account, nonce: ch.nonce, signature: await signErc191(ch.message) }
      : { kind, account, nonce: ch.nonce, ...(await signNep413({ message: ch.message, nonce: base64ToBytes(ch.nonce), recipient: ch.recipient })) };
  return postJson<Session>("/api/auth/verify", body);
}

export async function disconnectWallet(): Promise<void> {
  disconnectEvm();
  await disconnectNear();
}

/** Whether the wallet for this session is connected in this page as the session's account. */
export function walletConnected(s: Session): boolean {
  const a = s.kind === "evm" ? evmConnectedAccount() : nearConnectedAccount();
  return a !== null && a.toLowerCase() === s.account.toLowerCase();
}

/** Connect the session's wallet if needed and require it to be the signed-in account. */
export async function ensureWallet(s: Session): Promise<void> {
  if (walletConnected(s)) return;
  const { account } = await connectWallet(s.kind, s.kind === "near" ? s.account : undefined);
  if (account.toLowerCase() !== s.account.toLowerCase())
    throw new Error(`Your wallet is connected as ${account}, but you are signed in as ${s.account}. Switch accounts in your wallet and try again.`);
}
