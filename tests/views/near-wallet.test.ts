import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

// A Map-backed localStorage, installed before src/wallet/near.ts is used.
const mem = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
  },
});

const near = await import("../../src/wallet/near.ts");
const { NEAR_CONNECT_WALLETS } = await import("../../shared/near-connect-manifest.ts");

type Call = { method: string; args: unknown };
type Handler = (payload: { wallet: FakeWallet; accounts: { accountId: string }[] }) => void;

class FakeWallet {
  calls: Call[] = [];
  signedIn = false;
  manifest: { id: string; name: string };
  accounts: { accountId: string; publicKey?: string }[];
  constructor(manifest: { id: string; name: string }, accounts: { accountId: string; publicKey?: string }[]) {
    this.manifest = manifest;
    this.accounts = accounts;
  }
  async getAccounts(args?: unknown) {
    this.calls.push({ method: "getAccounts", args });
    return this.signedIn ? this.accounts : [];
  }
  async signMessage(args: { message: string; nonce: Uint8Array; recipient: string; signerId?: string }) {
    this.calls.push({ method: "signMessage", args });
    return { accountId: args.signerId ?? this.accounts[0].accountId, publicKey: "ed25519:PK", signature: "c2ln" };
  }
  txResult: unknown = {};
  txError: Error | null = null;
  async signAndSendTransaction(args: unknown) {
    this.calls.push({ method: "signAndSendTransaction", args });
    if (this.txError) throw this.txError;
    return this.txResult;
  }
  async signOut() {
    this.calls.push({ method: "signOut", args: null });
    this.signedIn = false;
  }
}

class FakeConnector {
  handlers = new Map<string, Handler[]>();
  selected: string | null = null;
  /** Which wallet the next connect() "picks" in the modal; null = the user closed it. */
  pick: string | null = null;
  wallets: Record<string, FakeWallet>;
  constructor(wallets: Record<string, FakeWallet>) {
    this.wallets = wallets;
  }
  on(event: string, cb: Handler) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]);
  }
  emit(event: string, payload: unknown) {
    for (const cb of this.handlers.get(event) ?? []) cb(payload as never);
  }
  async connect() {
    if (!this.pick) throw new Error("User rejected");
    const wallet = this.wallets[this.pick];
    wallet.signedIn = true;
    this.selected = this.pick;
    this.emit("wallet:signIn", { wallet, accounts: wallet.accounts, success: true, source: "signIn" });
    return wallet;
  }
  async wallet(id?: string | null) {
    const w = this.wallets[id ?? this.selected ?? ""];
    if (!w) throw new Error("Wallet not found");
    return w;
  }
  async disconnect(wallet: FakeWallet) {
    await wallet.signOut();
    this.emit("wallet:signOut", { success: true });
  }
}

let hot: FakeWallet;
let meteor: FakeWallet;
let conn: FakeConnector;
let created = 0;

beforeEach(() => {
  mem.clear();
  created = 0;
  hot = new FakeWallet({ id: "hot-wallet", name: "HOT Wallet" }, [{ accountId: "alice.near", publicKey: "ed25519:ALICE" }]);
  meteor = new FakeWallet({ id: "meteor-wallet", name: "Meteor Wallet" }, [{ accountId: "bob.near" }]);
  conn = new FakeConnector({ "hot-wallet": hot, "meteor-wallet": meteor });
  near.setConnectorFactoryForTests(async () => {
    created++;
    return conn as never;
  });
});

test("connectNear opens the connector, records the signer and persists it", async () => {
  conn.pick = "hot-wallet";
  assert.equal(await near.connectNear(), "alice.near");
  assert.equal(near.nearConnectedAccount(), "alice.near");
  assert.deepEqual(JSON.parse(mem.get(near.SIGNER_KEY)!), { walletId: "hot-wallet", accountId: "alice.near" });
  assert.deepEqual(await near.nearAccounts(), [{ accountId: "alice.near", walletName: "HOT Wallet" }]);
});

test("closing the wallet modal gives a plain message and connects nothing", async () => {
  conn.pick = null;
  await assert.rejects(near.connectNear(), /closed the wallet window/);
  assert.equal(near.nearConnectedAccount(), null);
  assert.equal(mem.has(near.SIGNER_KEY), false);
});

test("connecting another wallet as an address source never changes who signs", async () => {
  conn.pick = "hot-wallet";
  await near.connectNear();
  conn.pick = "meteor-wallet";
  assert.equal(await near.connectNear({ asSigner: false }), "bob.near");
  assert.equal(near.nearConnectedAccount(), "alice.near");
  assert.equal(JSON.parse(mem.get(near.SIGNER_KEY)!).walletId, "hot-wallet");
  // The connector now points at Meteor, but signing still goes to HOT.
  await near.signNep413({ message: "m", nonce: new Uint8Array(32), recipient: "r" });
  assert.equal(hot.calls.filter((c) => c.method === "signMessage").length, 1);
  assert.equal(meteor.calls.filter((c) => c.method === "signMessage").length, 0);
  const names = (await near.nearAccounts()).map((a) => `${a.walletName}:${a.accountId}`).sort();
  assert.deepEqual(names, ["HOT Wallet:alice.near", "Meteor Wallet:bob.near"]);
});

test("signNep413 passes the nonce as the plain Uint8Array and the signer id", async () => {
  conn.pick = "hot-wallet";
  await near.connectNear();
  const nonce = Uint8Array.from({ length: 32 }, (_, i) => i);
  const out = await near.signNep413({ message: "hello", nonce, recipient: "frenzypay" });
  assert.deepEqual(out, { publicKey: "ed25519:PK", signature: "c2ln" });
  const args = hot.calls.find((c) => c.method === "signMessage")!.args as Record<string, unknown>;
  assert.ok(args.nonce instanceof Uint8Array && !("_isBuffer" in (args.nonce as object)));
  assert.equal(args.nonce, nonce);
  assert.equal(args.signerId, "alice.near");
  assert.equal(args.recipient, "frenzypay");
});

test("signNep413 refuses a signature from another account", async () => {
  conn.pick = "hot-wallet";
  await near.connectNear();
  hot.signMessage = async () => ({ accountId: "mallory.near", publicKey: "ed25519:X", signature: "x" });
  await assert.rejects(near.signNep413({ message: "m", nonce: new Uint8Array(32), recipient: "r" }), /different account/);
});

test("signing without a connected wallet fails before loading the connector", async () => {
  await assert.rejects(near.signNep413({ message: "m", nonce: new Uint8Array(32), recipient: "r" }), /Connect a NEAR wallet first/);
  await assert.rejects(near.registerIntentsKey("ed25519:K"), /Connect a NEAR wallet first/);
  assert.equal(created, 0);
});

test("registerIntentsKey calls intents.near add_public_key with 100 Tgas and 1 yoctoNEAR", async () => {
  conn.pick = "hot-wallet";
  await near.connectNear();
  await near.registerIntentsKey("ed25519:NEWKEY");
  const tx = hot.calls.find((c) => c.method === "signAndSendTransaction")!.args as Record<string, unknown>;
  assert.equal(tx.receiverId, "intents.near");
  assert.equal(tx.signerId, "alice.near");
  assert.deepEqual(tx.actions, [
    { type: "FunctionCall", params: { methodName: "add_public_key", args: { public_key: "ed25519:NEWKEY" }, gas: "100000000000000", deposit: "1" } },
  ]);
});

test("nearPublicKey reads the signer's key from the wallet", async () => {
  assert.equal(await near.nearPublicKey(), null);
  conn.pick = "hot-wallet";
  await near.connectNear();
  assert.equal(await near.nearPublicKey(), "ed25519:ALICE");
});

test("restoreNear brings back the saved signer without opening the modal", async () => {
  mem.set(near.SIGNER_KEY, JSON.stringify({ walletId: "hot-wallet", accountId: "alice.near" }));
  hot.signedIn = true;
  await near.restoreNear();
  assert.equal(near.nearConnectedAccount(), "alice.near");
  // ensureWallet's path: a restored wallet for the expected account is reused as is.
  conn.pick = null;
  assert.equal(await near.connectNear({ expect: "alice.near" }), "alice.near");
});

test("restoreNear forgets a saved signer the wallet no longer reports", async () => {
  mem.set(near.SIGNER_KEY, JSON.stringify({ walletId: "hot-wallet", accountId: "alice.near" }));
  hot.signedIn = false;
  await near.restoreNear();
  assert.equal(near.nearConnectedAccount(), null);
  assert.equal(mem.has(near.SIGNER_KEY), false);
});

test("restoreNear loads nothing when no wallet was saved", async () => {
  await near.restoreNear();
  assert.equal(created, 0);
});

test("a restored wallet for a different account still opens the modal", async () => {
  mem.set(near.SIGNER_KEY, JSON.stringify({ walletId: "hot-wallet", accountId: "alice.near" }));
  hot.signedIn = true;
  conn.pick = "meteor-wallet";
  assert.equal(await near.connectNear({ expect: "bob.near" }), "bob.near");
  assert.equal(near.nearConnectedAccount(), "bob.near");
});

test("disconnectNear signs out of every wallet connected here and clears the saved signer", async () => {
  conn.pick = "hot-wallet";
  await near.connectNear();
  conn.pick = "meteor-wallet";
  await near.connectNear({ asSigner: false });
  await near.disconnectNear();
  assert.equal(near.nearConnectedAccount(), null);
  assert.equal(mem.has(near.SIGNER_KEY), false);
  assert.deepEqual(await near.nearAccounts(), []);
  assert.ok(hot.calls.some((c) => c.method === "signOut"));
  assert.ok(meteor.calls.some((c) => c.method === "signOut"));
});

test("a wallet:signOut event from the connector clears the signer", async () => {
  conn.pick = "hot-wallet";
  await near.connectNear();
  conn.emit("wallet:signOut", { success: true });
  assert.equal(near.nearConnectedAccount(), null);
  assert.equal(mem.has(near.SIGNER_KEY), false);
});

test("connector storage is namespaced and never keeps pasted debug wallets", async () => {
  await near.connectorStorage.set("selected-wallet", "hot-wallet");
  assert.equal(await near.connectorStorage.get("selected-wallet"), "hot-wallet");
  assert.equal(mem.get("frenzypay:near-connect:selected-wallet"), "hot-wallet");
  await near.connectorStorage.set("debug-wallets", JSON.stringify([{ id: "evil" }]));
  assert.equal(await near.connectorStorage.get("debug-wallets"), null);
  mem.set("frenzypay:near-connect:debug-wallets", "[]");
  assert.equal(await near.connectorStorage.get("debug-wallets"), null);
});

test("connector options pin the inline manifest and mainnet", () => {
  const o = near.connectorOptions();
  assert.equal(o.network, "mainnet");
  assert.equal(typeof o.manifest, "object");
  assert.deepEqual((o.manifest as { wallets: { id: string }[] }).wallets.map((w) => w.id), ["hot-wallet", "meteor-wallet"]);
  assert.equal(o.footerBranding, null);
  assert.equal(o.autoConnect, false);
  assert.deepEqual(o.features, { signMessage: true, signAndSendTransaction: true });
});

test("every wallet executor is pinned to a commit over https and can sign and send", () => {
  for (const w of NEAR_CONNECT_WALLETS) {
    const u = new URL(w.executor);
    assert.equal(u.protocol, "https:", w.id);
    assert.match(u.pathname, /\/[0-9a-f]{40}\//, `${w.id} executor must point at a commit, not a branch`);
    assert.equal(w.type, "sandbox");
    assert.equal(w.features.signMessage, true);
    assert.equal(w.features.signAndSendTransaction, true);
    assert.equal(w.features.mainnet, true);
    assert.ok(!w.icon.startsWith("http:"), w.id);
  }
});

// --- payNear ---

const USDC_NEAR = { assetId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", symbol: "USDC", blockchain: "near", decimals: 6 };
const DEPOSIT = "a".repeat(64);
const TX = "6xJZ3tYbKk7d8m9QpR2sT4uV5wX6yZ7aB8cD9eF1gH2j";
type TxArgs = { signerId: string; receiverId: string; actions: { params: Record<string, unknown> }[] };

test("payNear: NEP-141 is storage_deposit for the deposit address then ft_transfer with 1 yocto, on the token contract", async () => {
  conn.pick = "meteor-wallet";
  meteor.txResult = { transaction_outcome: { id: TX } };
  assert.deepEqual(await near.payNear(USDC_NEAR, DEPOSIT, "710180"), { txHash: TX, accountId: "bob.near" });
  const args = meteor.calls.find((c) => c.method === "signAndSendTransaction")!.args as TxArgs;
  assert.equal(args.signerId, "bob.near");
  assert.equal(args.receiverId, USDC_NEAR.assetId.slice(7));
  assert.deepEqual(args.actions.map((a) => [a.params.methodName, a.params.args, a.params.deposit]), [
    ["storage_deposit", { account_id: DEPOSIT, registration_only: true }, "1250000000000000000000"],
    ["ft_transfer", { receiver_id: DEPOSIT, amount: "710180" }, "1"],
  ]);
  // Paying never makes the paying wallet the app's signer.
  assert.equal(near.nearConnectedAccount(), null);
});

test("payNear: wNEAR wraps the payer's native NEAR in the same transaction, using the signed-in wallet", async () => {
  conn.pick = "hot-wallet";
  await near.connectNear();
  hot.txResult = { transaction: { hash: TX } };
  const r = await near.payNear({ assetId: "nep141:wrap.near", symbol: "wNEAR", blockchain: "near", decimals: 24 }, "dep.near", "2000000000000000000000000");
  assert.equal(r.accountId, "alice.near");
  const args = hot.calls.find((c) => c.method === "signAndSendTransaction")!.args as TxArgs;
  assert.equal(args.receiverId, "wrap.near");
  assert.deepEqual(args.actions.map((a) => a.params.methodName), ["storage_deposit", "storage_deposit", "near_deposit", "ft_transfer"]);
  assert.equal(args.actions[2].params.deposit, "2000000000000000000000000");
  assert.deepEqual(args.actions[1].params.args, { account_id: "alice.near", registration_only: true });
});

test("payNear: a rejection in the wallet is code 4001 with a plain message; no hash is an error", async () => {
  conn.pick = "meteor-wallet";
  meteor.txError = new Error("User rejected the request");
  await assert.rejects(near.payNear(USDC_NEAR, DEPOSIT, "1"), (e: Error & { code?: number }) => e.code === 4001 && /Nothing was sent/.test(e.message));
  meteor.txError = null;
  meteor.txResult = {};
  await assert.rejects(near.payNear(USDC_NEAR, DEPOSIT, "1"), /did not return a transaction hash/);
});

test("payNear refuses tokens it cannot pay before opening any wallet", async () => {
  await assert.rejects(near.payNear({ ...USDC_NEAR, blockchain: "arb" }, DEPOSIT, "1"), /cannot be paid from a NEAR wallet/);
  await assert.rejects(near.payNear(USDC_NEAR, DEPOSIT, "0"), /cannot be paid/);
  assert.equal(created, 0);
});
