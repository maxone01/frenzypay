// NEAR wallets via @hot-labs/near-connect. The user picks a wallet in the connector's own modal; each wallet's
// code runs in a sandboxed iframe loaded from the pinned list in shared/near-connect-manifest.ts. The connector
// is imported lazily, so the app shell does not load it until a NEAR wallet is used or restored.
//
// The signing wallet is persisted under our own key (SIGNER_KEY), not the connector's "selected-wallet":
// "Connect another NEAR wallet" also goes through connector.connect(), which moves the connector's selection,
// and that must never change who signs.
import type { ConnectorAction, DataStorage, NearConnector, NearConnectorOptions, NearWalletBase, WalletManifest } from "@hot-labs/near-connect";
import { NEAR_CONNECT_RPC, NEAR_CONNECT_WALLETS } from "../../shared/near-connect-manifest.ts";
import { nearPayActions, nearPayPlan, type PayToken } from "../../shared/wallet-pay.ts";
import { watchWalletModal } from "./near-modal.ts";

type Connector = Pick<NearConnector, "connect" | "wallet" | "disconnect" | "on">;
type Signer = { walletId: string; accountId: string };

export const SIGNER_KEY = "frenzypay:near-signer";
const CONNECTOR_PREFIX = "frenzypay:near-connect:";

let connectorPromise: Promise<Connector> | null = null;
let restoring: Promise<void> | null = null;
let current: Signer | null = null;
/** Every account a wallet returned in this page (account id → wallet name), for "Use a connected wallet". */
const known = new Map<string, string>();
/** Wallets signed in from this page, so signing out of the app signs out of all of them. */
const connectedWallets = new Set<string>();

function store(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * The connector's own storage, namespaced. It also drops "debug-wallets": the modal's settings screen can
 * register any pasted manifest and the connector reloads those on every visit, which would let someone talk a
 * user into adding a fake wallet. The settings button is hidden as well (src/style.css).
 */
export const connectorStorage: DataStorage = {
  async get(key) {
    return key === "debug-wallets" ? null : (store()?.getItem(CONNECTOR_PREFIX + key) ?? null);
  },
  async set(key, value) {
    if (key !== "debug-wallets") store()?.setItem(CONNECTOR_PREFIX + key, value);
  },
  async remove(key) {
    store()?.removeItem(CONNECTOR_PREFIX + key);
  },
};

function readSigner(): Signer | null {
  try {
    const v = JSON.parse(store()?.getItem(SIGNER_KEY) ?? "null") as Partial<Signer> | null;
    return typeof v?.walletId === "string" && typeof v.accountId === "string" && v.walletId && v.accountId ? { walletId: v.walletId, accountId: v.accountId } : null;
  } catch {
    return null;
  }
}
const saveSigner = (s: Signer) => store()?.setItem(SIGNER_KEY, JSON.stringify(s));
const clearSigner = () => store()?.removeItem(SIGNER_KEY);

/** The nonce the page's scripts were served with (server/csp.ts); the wallet iframe's inline scripts need it. */
function pageNonce(): string | undefined {
  if (typeof document === "undefined") return undefined;
  return document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce || undefined;
}

export function connectorOptions(): NearConnectorOptions {
  return {
    network: "mainnet",
    // Inline manifest: nothing is fetched to decide which wallets exist or where their code comes from.
    manifest: { version: "frenzypay-1", wallets: NEAR_CONNECT_WALLETS as unknown as WalletManifest[] },
    providers: { mainnet: [NEAR_CONNECT_RPC], testnet: [] },
    // Sign-in needs signMessage, key registration needs signAndSendTransaction. Also applied to wallets a
    // browser extension injects into the page, which join the list next to the two pinned ones.
    features: { signMessage: true, signAndSendTransaction: true },
    storage: connectorStorage,
    // Only matters when this app is framed by a wallet, which frame-ancestors 'none' already forbids.
    autoConnect: false,
    footerBranding: null,
    cspNonce: pageNonce(),
  };
}

let createConnector = async (): Promise<Connector> => {
  const { NearConnector } = await import("@hot-labs/near-connect");
  return new NearConnector(connectorOptions());
};

/** Tests swap in a fake connector. Also resets this module's state. */
export function setConnectorFactoryForTests(factory: () => Promise<Connector>): void {
  createConnector = factory;
  connectorPromise = null;
  restoring = null;
  current = null;
  known.clear();
  connectedWallets.clear();
}

function remember(wallet: NearWalletBase, accounts: { accountId?: unknown }[] | undefined): void {
  connectedWallets.add(wallet.manifest.id);
  for (const a of accounts ?? []) if (typeof a?.accountId === "string" && a.accountId) known.set(a.accountId, wallet.manifest.name);
}

function connector(): Promise<Connector> {
  connectorPromise ??= createConnector()
    .then((c) => {
      c.on("wallet:signIn", ({ wallet, accounts }) => remember(wallet, accounts));
      c.on("wallet:signOut", () => {
        current = null;
        known.clear();
        clearSigner();
      });
      return c;
    })
    .catch((e) => {
      connectorPromise = null;
      throw e;
    });
  return connectorPromise;
}

/**
 * Bring back the signing wallet from an earlier visit, if it still reports the same account. Loads nothing
 * when no NEAR wallet was saved. Called once at startup; connectNear waits for it.
 */
export function restoreNear(): Promise<void> {
  restoring ??= (async () => {
    const saved = readSigner();
    if (!saved) return;
    try {
      const wallet = await (await connector()).wallet(saved.walletId);
      const accounts = await wallet.getAccounts({ network: "mainnet" });
      if (!accounts?.some((a) => a.accountId === saved.accountId)) return void clearSigner();
      remember(wallet, accounts);
      current ??= saved;
    } catch {
      /* wallet code unreachable or locked: keep the saved choice for the next visit, connect fresh this time */
    }
  })();
  return restoring;
}

function friendly(e: unknown): Error {
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  if (/user rejected/i.test(msg)) return new Error("You closed the wallet window. No wallet was connected.");
  return e instanceof Error ? e : new Error(msg || "The wallet did not connect. Try again.");
}

/** Open the connector's modal and return the wallet the user picked and its first account. Never changes the signer. */
async function pickWallet(): Promise<{ wallet: NearWalletBase; accountId: string }> {
  const c = await connector();
  const stopWatching = watchWalletModal();
  let wallet: NearWalletBase;
  let accounts: { accountId: string }[];
  try {
    await c.connect();
    wallet = await c.wallet();
    accounts = await wallet.getAccounts({ network: "mainnet" });
  } catch (e) {
    throw friendly(e);
  } finally {
    stopWatching();
  }
  const accountId = accounts?.[0]?.accountId;
  if (typeof accountId !== "string" || !accountId) throw new Error("The wallet did not return an account.");
  remember(wallet, accounts);
  return { wallet, accountId };
}

/**
 * Connect a NEAR wallet through the connector's wallet modal. `asSigner: false` only records the accounts (to
 * offer them as destination addresses) and leaves the signing account alone. `expect` reuses the restored
 * signing wallet without a modal when it is already connected as that account.
 */
export async function connectNear(opts: { asSigner?: boolean; expect?: string } = {}): Promise<string> {
  const asSigner = opts.asSigner !== false;
  if (asSigner && opts.expect) {
    await restoreNear();
    if (current && current.accountId === opts.expect) return current.accountId;
  }
  const { wallet, accountId } = await pickWallet();
  if (asSigner) {
    current = { walletId: wallet.manifest.id, accountId };
    saveSigner(current);
  }
  return accountId;
}

async function signerWallet(): Promise<{ wallet: NearWalletBase; signer: Signer }> {
  const signer = current;
  if (!signer) throw new Error("Connect a NEAR wallet first.");
  return { wallet: await (await connector()).wallet(signer.walletId), signer };
}

/**
 * Accounts the NEAR wallets in this page already reported, without opening any wallet UI. Loads nothing when
 * no NEAR wallet was connected here. The only NEAR-side input to src/wallet/accounts.ts.
 */
export async function nearAccounts(): Promise<{ accountId: string; walletName: string }[]> {
  if (current && connectorPromise) {
    try {
      const { wallet } = await signerWallet();
      remember(wallet, await wallet.getAccounts({ network: "mainnet" }));
    } catch {
      /* wallet locked or gone: keep what it already reported */
    }
  }
  return [...known].map(([accountId, walletName]) => ({ accountId, walletName }));
}

/** NEP-413 signMessage. Returns the wallet's `ed25519:<base58>` public key and base64 signature. */
export async function signNep413(p: { message: string; nonce: Uint8Array; recipient: string }): Promise<{ publicKey: string; signature: string }> {
  const { wallet, signer } = await signerWallet();
  // near-connect takes the 32 nonce bytes as a plain Uint8Array.
  const signed = await wallet.signMessage({ message: p.message, nonce: p.nonce, recipient: p.recipient, network: "mainnet", signerId: signer.accountId });
  if (!signed) throw new Error("The wallet did not return a signature.");
  if (signed.accountId !== signer.accountId) throw new Error("The wallet signed with a different account than the one connected.");
  return { publicKey: signed.publicKey, signature: signed.signature };
}

/** Sign out of every NEAR wallet connected in this page and forget the saved signer. */
export async function disconnectNear(): Promise<void> {
  const ids = [...connectedWallets];
  if (current) ids.push(current.walletId);
  current = null;
  known.clear();
  connectedWallets.clear();
  clearSigner();
  if (!connectorPromise) return;
  const c = await connectorPromise.catch(() => null);
  for (const id of new Set(ids)) {
    try {
      await c?.disconnect(await c.wallet(id));
    } catch {
      /* best effort */
    }
  }
}

/** The connected account's public key as reported by the wallet, if it reports one. */
export async function nearPublicKey(): Promise<string | null> {
  if (!current) return null;
  try {
    const { wallet, signer } = await signerWallet();
    const acc = (await wallet.getAccounts({ network: "mainnet" })).find((a) => a.accountId === signer.accountId);
    return typeof acc?.publicKey === "string" && acc.publicKey ? acc.publicKey : null;
  } catch {
    return null;
  }
}

/** intents.near `add_public_key({public_key})`, 100 Tgas, 1 yoctoNEAR attached. */
export function addPublicKeyAction(publicKey: string): ConnectorAction {
  return { type: "FunctionCall", params: { methodName: "add_public_key", args: { public_key: publicKey }, gas: "100000000000000", deposit: "1" } };
}

/** One-time registration so intents.near accepts this key's NEP-413 signatures for the account. */
export async function registerIntentsKey(publicKey: string): Promise<void> {
  const { wallet, signer } = await signerWallet();
  await wallet.signAndSendTransaction({ network: "mainnet", signerId: signer.accountId, receiverId: "intents.near", actions: [addPublicKeyAction(publicKey)] });
}

/**
 * Pay a 1Click deposit address on NEAR in one transaction on the token contract (see nearPayActions):
 * storage registration for the deposit address, then ft_transfer of the exact amount with 1 yoctoNEAR; for
 * wrap.near the payer's native NEAR is wrapped first. Uses the signed-in NEAR wallet when there is one,
 * otherwise opens the wallet modal (without making that wallet the app's signer). The wallet asks the payer
 * to approve. Returns the transaction hash and the paying account.
 */
export async function payNear(token: PayToken, depositAddress: string, amount: string): Promise<{ txHash: string; accountId: string }> {
  const plan = nearPayPlan(token, depositAddress, amount);
  if (!plan) throw new Error("This token cannot be paid from a NEAR wallet here. Copy the address and amount instead.");
  const { wallet, accountId } = current ? await signerWallet().then((s) => ({ wallet: s.wallet, accountId: s.signer.accountId })) : await pickWallet();
  let out: unknown;
  try {
    out = await wallet.signAndSendTransaction({ network: "mainnet", signerId: accountId, receiverId: plan.contract, actions: nearPayActions(plan, accountId) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
    if (/user rejected|rejected by user|cancel/i.test(msg)) throw Object.assign(new Error("You declined in your wallet. Nothing was sent."), { code: 4001 });
    throw e instanceof Error ? e : new Error(msg || "The wallet did not send the payment.");
  }
  const o = out as { transaction_outcome?: { id?: unknown }; transaction?: { hash?: unknown } } | null;
  const txHash = o?.transaction_outcome?.id ?? o?.transaction?.hash;
  if (typeof txHash !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(txHash))
    throw new Error("The wallet did not return a transaction hash. Check your wallet's activity before paying again.");
  return { txHash, accountId };
}

export function nearConnectedAccount(): string | null {
  return current?.accountId ?? null;
}
