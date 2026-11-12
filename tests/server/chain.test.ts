import test from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58, base64 } from "@scure/base";
import { createTestDb, type TestDb } from "./d1-shim.ts";
import { nep413Hash } from "../../server/auth.ts";
import {
  chainConfig, chainState, encodeTransaction, explorerTxUrl, failureText, invoicePayload, NonceError, payloadHash, prepareChainWrite,
  publicInvoiceFromChain, relayChain, removePayeeOnChain, signedMessage, signTransaction, submitChainWrite, STALE_PENDING_MS,
  type ChainConfig, type ChainDeps, type ChainRpc, type TxResult,
} from "../../server/chain.ts";
import type { Env } from "../../server/env.ts";
import { createInvoice, issueInvoice, cancelInvoice } from "../../server/invoices.ts";
import { SETTLEMENT_TOKENS } from "../../shared/assets.ts";
import type { InvoiceDraft } from "../../shared/invoice.ts";

const OWNER = "alice.near";
const USER = { account: OWNER, kind: "near" as const };
const CONTRACT = "frenzypay.maxkumbang.near";
const RELAYER = "maxkumbang.near";
const NOW = "2030-01-01T00:00:00.000Z";
const draft: InvoiceDraft = {
  number: "INV-1", client: "Demo Client", issuer: "Example Studio", dueDate: "2030-01-31", tokenId: SETTLEMENT_TOKENS[0].tokenId, notes: "",
  items: [{ description: "Design", quantity: "2", unitPrice: "1.5" }], clientEmail: "billing@client.example",
};

const relayerSeed = new Uint8Array(32).fill(7);
const relayerPub = ed25519.getPublicKey(relayerSeed);
const ownerSeed = new Uint8Array(32).fill(9);
const ownerPk = "ed25519:" + base58.encode(ed25519.getPublicKey(ownerSeed));
const cfg: ChainConfig = { network: "mainnet", rpcUrl: "http://rpc.invalid", contractId: CONTRACT, relayerId: RELAYER, relayerPublicKey: relayerPub, relayerSeed };

/** Reads the method and JSON args back out of a signed single-FunctionCall transaction. */
function decodeTx(b64: string): { signer: string; receiver: string; nonce: bigint; method: string; args: Record<string, unknown>; verified: boolean } {
  const b = base64.decode(b64);
  const dv = new DataView(b.buffer, b.byteOffset);
  let o = 0;
  const str = () => {
    const n = dv.getUint32(o, true);
    o += 4;
    const s = new TextDecoder().decode(b.slice(o, o + n));
    o += n;
    return s;
  };
  const signer = str();
  o += 1;
  const pk = b.slice(o, o + 32);
  o += 32;
  const nonce = dv.getBigUint64(o, true);
  o += 8;
  const receiver = str();
  o += 32 + 4;
  assert.equal(b[o], 2, "FunctionCall action");
  o += 1;
  const method = str();
  const n = dv.getUint32(o, true);
  o += 4;
  const args = JSON.parse(new TextDecoder().decode(b.slice(o, o + n)));
  o += n + 8 + 16;
  const unsigned = b.slice(0, o);
  assert.equal(b[o], 0, "ed25519 signature");
  const sig = b.slice(o + 1, o + 65);
  return { signer, receiver, nonce, method, args, verified: ed25519.verify(sig, sha256(unsigned), pk) };
}

type Sent = ReturnType<typeof decodeTx>;
function fakeRpc(o: { send?: (s: Sent) => TxResult | Promise<TxResult>; registered?: boolean; ownerKey?: "FullAccess" | "fc" | null; status?: TxResult; chainInvoice?: unknown } = {}) {
  const sent: Sent[] = [];
  const views: string[] = [];
  let nonce = 10n;
  const rpc: ChainRpc = {
    async accessKey(account, pk) {
      if (account === RELAYER) return pk === "ed25519:" + base58.encode(relayerPub) ? { nonce, blockHash: new Uint8Array(32).fill(1), permission: { FunctionCall: {} } } : null;
      if (account === OWNER && pk === ownerPk && o.ownerKey !== null) return { nonce: 1n, blockHash: new Uint8Array(32), permission: o.ownerKey === "fc" ? { FunctionCall: {} } : "FullAccess" };
      return null;
    },
    async sendTx(b64) {
      const s = decodeTx(b64);
      sent.push(s);
      nonce = s.nonce;
      return o.send ? o.send(s) : { state: "success" };
    },
    async txStatus() {
      return o.status ?? { state: "unknown" };
    },
    async view<T>(_c: string, method: string): Promise<T> {
      views.push(method);
      if (method === "get_key") return (o.registered ? { source: "self", registered_at_ms: 1 } : null) as T;
      if (method === "get_invoice") return (o.chainInvoice ?? null) as T;
      return null as T;
    },
  };
  return { rpc, sent, views };
}

const depsOf = (db: TestDb, rpc: ChainRpc, now = new Date(NOW)): ChainDeps => ({ db, cfg, rpc, now });

function ownerSign(req: { message: string; nonce: string; recipient: string }) {
  const hash = nep413Hash({ message: req.message, nonce: base64.decode(req.nonce), recipient: req.recipient, callbackUrl: null });
  return { nonce: req.nonce, publicKey: ownerPk, signature: base64.encode(ed25519.sign(hash, ownerSeed)) };
}

async function issued(db: TestDb) {
  const d = await createInvoice(db, OWNER, draft, NOW);
  return issueInvoice(db, OWNER, d.id, NOW);
}

const env = (over: Partial<Env>): Env =>
  ({
    DB: createTestDb(), SESSION_SECRET: "s".repeat(32), NEAR_RPC_URL: "http://rpc.invalid", ONECLICK_BASE_URL: "http://oc.invalid",
    CHAIN_WRITES_ENABLED: "true", CONTRACT_ID: CONTRACT, RELAYER_ACCOUNT_ID: RELAYER,
    RELAYER_PUBLIC_KEY: "ed25519:" + base58.encode(relayerPub), RELAYER_PRIVATE_KEY: "ed25519:" + base58.encode(new Uint8Array([...relayerSeed, ...relayerPub])),
    ...over,
  }) as Env;

test("chainConfig: off unless CHAIN_WRITES_ENABLED=true and every variable is set; the key pair must match", () => {
  assert.ok(chainConfig(env({})));
  assert.equal(chainConfig(env({ CHAIN_WRITES_ENABLED: "false" })), null);
  assert.equal(chainConfig(env({ CHAIN_WRITES_ENABLED: undefined })), null);
  assert.equal(chainConfig(env({ CONTRACT_ID: "" })), null);
  assert.equal(chainConfig(env({ RELAYER_PRIVATE_KEY: undefined })), null);
  // a bare 32-byte seed is accepted
  assert.ok(chainConfig(env({ RELAYER_PRIVATE_KEY: "ed25519:" + base58.encode(relayerSeed) })));
  const err = console.error;
  console.error = () => {};
  try {
    assert.equal(chainConfig(env({ RELAYER_PRIVATE_KEY: "ed25519:" + base58.encode(ownerSeed) })), null);
    assert.equal(chainConfig(env({ RELAYER_PUBLIC_KEY: "not-a-key" })), null);
  } finally {
    console.error = err;
  }
  assert.equal(chainConfig(env({}))?.network, "mainnet");
  assert.equal(chainConfig(env({ NEAR_NETWORK: "testnet" }))?.network, "testnet");
});

test("explorer links follow the network", () => {
  assert.equal(explorerTxUrl("mainnet", "AbC"), "https://nearblocks.io/txns/AbC");
  assert.equal(explorerTxUrl("testnet", "AbC"), "https://testnet.nearblocks.io/txns/AbC");
});

test("signTransaction: hash is base58 sha256 of the borsh transaction and the signature verifies", () => {
  const t = { signerId: RELAYER, publicKey: relayerPub, nonce: 11n, receiverId: CONTRACT, blockHash: new Uint8Array(32).fill(3), method: "put_invoice", args: new TextEncoder().encode("{}"), gas: 1n, deposit: 0n };
  const { signedB64, hash } = signTransaction(t, relayerSeed);
  assert.equal(hash, base58.encode(sha256(encodeTransaction(t))));
  const d = decodeTx(signedB64);
  assert.deepEqual([d.signer, d.receiver, d.nonce, d.method, d.verified], [RELAYER, CONTRACT, 11n, "put_invoice", true]);
});

test("invoice payload is public data only: no client email; message names action, owner and payload hash", async () => {
  const db = createTestDb();
  const inv = await issued(db);
  const p = invoicePayload(inv);
  assert.ok(!p.includes("billing@client.example"));
  assert.deepEqual(Object.keys(JSON.parse(p)), ["public_id", "number", "issuer", "client", "due_date", "token_id", "total", "notes", "items", "created_at", "issued_at"]);
  assert.equal(signedMessage("put_invoice", OWNER, p), `FrenzyPay public record\naction: put_invoice\nowner: ${OWNER}\npayload_sha256: ${payloadHash(p)}`);
  assert.match(payloadHash(p), /^[0-9a-f]{64}$/);
});

test("publish an issued invoice: prepare asks for a signature, submit relays it with key attestation", async () => {
  const db = createTestDb();
  const inv = await issued(db);
  const { rpc, sent } = fakeRpc();
  const deps = depsOf(db, rpc);
  assert.equal((await chainState(deps, USER, "invoice", inv.id)).status, "unpublished");
  const { sign } = await prepareChainWrite(deps, USER, "invoice", inv.id);
  assert.ok(sign);
  assert.equal(sign.action, "put_invoice");
  assert.equal(sign.recipient, CONTRACT);
  const v = await submitChainWrite(deps, USER, "invoice", inv.id, ownerSign(sign));
  assert.equal(v.status, "confirmed");
  assert.equal(v.synced, "issued");
  assert.equal(v.txUrl, `https://nearblocks.io/txns/${v.tx}`);
  assert.equal(sent.length, 1);
  const s = sent[0]!;
  assert.deepEqual([s.signer, s.receiver, s.method, s.nonce, s.verified], [RELAYER, CONTRACT, "put_invoice", 11n, true]);
  assert.equal(s.args.payload, sign.payload);
  assert.deepEqual({ ...(s.args.auth as object), signature: "x" }, { owner: OWNER, public_key: ownerPk, nonce: sign.nonce, signature: "x", attest_key: true });
  // nothing more to do
  assert.equal((await prepareChainWrite(deps, USER, "invoice", inv.id)).sign, undefined);
});

test("a key the contract already has is not attested again", async () => {
  const db = createTestDb();
  const inv = await issued(db);
  const { rpc, sent } = fakeRpc({ registered: true, ownerKey: null });
  const deps = depsOf(db, rpc);
  const { sign } = await prepareChainWrite(deps, USER, "invoice", inv.id);
  await submitChainWrite(deps, USER, "invoice", inv.id, ownerSign(sign!));
  assert.equal((sent[0]!.args.auth as { attest_key: boolean }).attest_key, false);
});

test("bad or foreign signatures and non-full-access keys never reach the chain", async () => {
  const db = createTestDb();
  const inv = await issued(db);
  const { rpc, sent } = fakeRpc();
  const deps = depsOf(db, rpc);
  const { sign } = await prepareChainWrite(deps, USER, "invoice", inv.id);
  const good = ownerSign(sign!);
  const code = (p: Promise<unknown>) => p.then(() => 0, (e: { status?: number }) => e.status);
  // signed for another message
  assert.equal(await code(submitChainWrite(deps, USER, "invoice", inv.id, ownerSign({ ...sign!, message: "something else" }))), 400);
  // signed for another recipient
  assert.equal(await code(submitChainWrite(deps, USER, "invoice", inv.id, ownerSign({ ...sign!, recipient: "evil.near" }))), 400);
  assert.equal(await code(submitChainWrite(deps, USER, "invoice", inv.id, { ...good, signature: "AAAA" })), 400);
  // a function-call key of the owner is not enough
  const fc = fakeRpc({ ownerKey: "fc" });
  assert.equal(await code(submitChainWrite(depsOf(db, fc.rpc), USER, "invoice", inv.id, good)), 403);
  // an EVM session cannot sign NEP-413
  assert.equal(await code(submitChainWrite(deps, { account: "0xabc", kind: "evm" }, "invoice", inv.id, good)), 409);
  assert.equal(sent.length + fc.sent.length, 0);
});

test("transport failure keeps the signed write; retry resubmits it without a new signature", async () => {
  const db = createTestDb();
  const inv = await issued(db);
  let down = true;
  const { rpc, sent } = fakeRpc({
    send: () => {
      if (down) throw new Error("connection reset");
      return { state: "success" };
    },
  });
  const deps = depsOf(db, rpc);
  const warn = console.warn;
  console.warn = () => {};
  try {
    const { sign } = await prepareChainWrite(deps, USER, "invoice", inv.id);
    const v = await submitChainWrite(deps, USER, "invoice", inv.id, ownerSign(sign!));
    assert.equal(v.status, "failed");
    assert.equal(v.canPublish, true);
    down = false;
    const again = await prepareChainWrite(deps, USER, "invoice", inv.id);
    assert.equal(again.sign, undefined);
    assert.equal(again.state.status, "confirmed");
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1]!.args, sent[0]!.args);
  } finally {
    console.warn = warn;
  }
});

test("a contract refusal fails the write and the next attempt asks for a fresh signature", async () => {
  const db = createTestDb();
  const inv = await issued(db);
  const { rpc } = fakeRpc({ send: () => ({ state: "failure", error: "ERR_KEY_NOT_REGISTERED" }) });
  const deps = depsOf(db, rpc);
  const { sign } = await prepareChainWrite(deps, USER, "invoice", inv.id);
  const v = await submitChainWrite(deps, USER, "invoice", inv.id, ownerSign(sign!));
  assert.equal(v.status, "failed");
  assert.equal(v.error, "ERR_KEY_NOT_REGISTERED");
  assert.ok((await prepareChainWrite(deps, USER, "invoice", inv.id)).sign);
});

test("a refusal for a write that already landed is recorded as confirmed", async () => {
  const db = createTestDb();
  const inv = await issued(db);
  const { rpc } = fakeRpc({ send: () => ({ state: "failure", error: "ERR_EXISTS" }), chainInvoice: { status: "issued" } });
  const deps = depsOf(db, rpc);
  const { sign } = await prepareChainWrite(deps, USER, "invoice", inv.id);
  assert.equal((await submitChainWrite(deps, USER, "invoice", inv.id, ownerSign(sign!))).status, "confirmed");
});

test("no answer in time stays pending, settles from the tx status, and is given up after the stale window", async () => {
  const db = createTestDb();
  const inv = await issued(db);
  const fake = fakeRpc({ send: () => ({ state: "unknown" }) });
  const deps = depsOf(db, fake.rpc);
  const { sign } = await prepareChainWrite(deps, USER, "invoice", inv.id);
  const v = await submitChainWrite(deps, USER, "invoice", inv.id, ownerSign(sign!));
  assert.equal(v.status, "pending");
  assert.ok(v.tx);
  // while pending nothing new is signed or sent
  assert.equal((await prepareChainWrite(deps, USER, "invoice", inv.id)).sign, undefined);
  assert.equal((await chainState(deps, USER, "invoice", inv.id)).status, "pending");
  const later = depsOf(db, fake.rpc, new Date(Date.parse(NOW) + STALE_PENDING_MS + 1000));
  const gone = await chainState(later, USER, "invoice", inv.id);
  assert.equal(gone.status, "failed");
  // and a landed one settles
  const db2 = createTestDb();
  const inv2 = await issued(db2);
  const f2 = fakeRpc({ send: () => ({ state: "unknown" }), status: { state: "success" } });
  const d2 = depsOf(db2, f2.rpc);
  const s2 = (await prepareChainWrite(d2, USER, "invoice", inv2.id)).sign!;
  await submitChainWrite(d2, USER, "invoice", inv2.id, ownerSign(s2));
  assert.equal((await chainState(d2, USER, "invoice", inv2.id)).status, "confirmed");
});

test("payment confirmation: the relayer marks a published invoice paid, with no owner signature", async () => {
  const db = createTestDb();
  const inv = await issued(db);
  const { rpc, sent } = fakeRpc();
  const deps = depsOf(db, rpc);
  const { sign } = await prepareChainWrite(deps, USER, "invoice", inv.id);
  await submitChainWrite(deps, USER, "invoice", inv.id, ownerSign(sign!));
  await db.prepare(
    "INSERT INTO payment_attempts (deposit_address, invoice_id, origin_asset, amount_in, refund_to, deadline, status, upstream, created_at, updated_at) VALUES ('dep1', ?, 'a', '1', 'r', ?, 'SUCCESS', ?, ?, ?)",
  ).bind(inv.id, NOW, JSON.stringify({ destinationTxHashes: ["DestTx1"] }), NOW, NOW).run();
  await db.prepare("UPDATE invoices SET status = 'paid', paid_by = 'dep1', paid_at = ? WHERE id = ?").bind(NOW, inv.id).run();
  await relayChain(deps, OWNER, "invoice", inv.id);
  assert.equal(sent.length, 2);
  assert.equal(sent[1]!.method, "mark_invoice_paid");
  assert.deepEqual(sent[1]!.args, { public_id: inv.publicId, deposit_address: "dep1", tx_hash: "DestTx1" });
  const v = await chainState(deps, USER, "invoice", inv.id);
  assert.deepEqual([v.status, v.synced], ["confirmed", "paid"]);
  // once paid, nothing is sent again
  await relayChain(deps, OWNER, "invoice", inv.id);
  assert.equal(sent.length, 2);
});

test("relayChain does nothing for an unpublished invoice and never throws", async () => {
  const db = createTestDb();
  const inv = await issued(db);
  const { rpc, sent } = fakeRpc();
  await relayChain(depsOf(db, rpc), OWNER, "invoice", inv.id);
  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (m: string) => warned.push(m);
  try {
    await relayChain(depsOf(db, rpc), OWNER, "invoice", "missing");
  } finally {
    console.warn = warn;
  }
  assert.equal(warned.length, 1);
  await relayChain(null, OWNER, "invoice", inv.id);
  assert.equal(sent.length, 0);
});

test("cancelling a published invoice needs a cancel signature; an unpublished cancelled one needs nothing", async () => {
  const db = createTestDb();
  const inv = await issued(db);
  const { rpc, sent } = fakeRpc();
  const deps = depsOf(db, rpc);
  const s1 = (await prepareChainWrite(deps, USER, "invoice", inv.id)).sign!;
  await submitChainWrite(deps, USER, "invoice", inv.id, ownerSign(s1));
  await cancelInvoice(db, OWNER, inv.id, NOW);
  const s2 = (await prepareChainWrite(deps, USER, "invoice", inv.id)).sign!;
  assert.equal(s2.action, "cancel_invoice");
  assert.equal(s2.payload, JSON.stringify({ public_id: inv.publicId }));
  assert.equal((await submitChainWrite(deps, USER, "invoice", inv.id, ownerSign(s2))).synced, "cancelled");
  assert.deepEqual(sent.map((s) => s.method), ["put_invoice", "cancel_invoice"]);

  const other = await issued(db);
  await cancelInvoice(db, OWNER, other.id, NOW);
  assert.equal((await chainState(deps, USER, "invoice", other.id)).status, "none");
});

test("EVM sessions see the record as unavailable; drafts have nothing to publish", async () => {
  const db = createTestDb();
  const inv = await issued(db);
  const { rpc } = fakeRpc();
  const deps = depsOf(db, rpc);
  const evm = { account: OWNER, kind: "evm" as const };
  assert.equal((await chainState(deps, evm, "invoice", inv.id)).status, "unavailable");
  await assert.rejects(prepareChainWrite(deps, evm, "invoice", inv.id), { status: 409 });
  const d = await createInvoice(db, OWNER, draft, NOW);
  assert.equal((await chainState(deps, USER, "invoice", d.id)).status, "none");
  await assert.rejects(chainState(deps, { account: "bob.near", kind: "near" }, "invoice", inv.id), { status: 404 });
});

test("a bill edited after publishing needs publishing again; payees likewise", async () => {
  const db = createTestDb();
  const ins = (id: string, amount: string) =>
    db.prepare(
      `INSERT INTO bills (id, owner, vendor, reference, due_date, destination_asset, recipient_type, recipient, amount, source, vendor_public_id, status, deposit_address, created_at, updated_at)
       VALUES (?, ?, 'Vendor', 'R-1', '2030-02-01', 'nep141:usdc', 'INTENTS', 'vendor.near', ?, 'manual', NULL, 'scheduled', NULL, ?, ?)`,
    ).bind(id, OWNER, amount, NOW, NOW).run();
  await ins("b1", "100");
  const { rpc, sent } = fakeRpc();
  const deps = depsOf(db, rpc);
  const s1 = (await prepareChainWrite(deps, USER, "bill", "b1")).sign!;
  assert.equal(s1.action, "put_bill");
  assert.equal(JSON.parse(s1.payload).vendor_public_id, null);
  assert.equal((await submitChainWrite(deps, USER, "bill", "b1", ownerSign(s1))).status, "confirmed");
  assert.equal((await chainState(deps, USER, "bill", "b1")).synced, "scheduled");
  await db.prepare("UPDATE bills SET amount = '200' WHERE id = 'b1'").bind().run();
  assert.equal((await chainState(deps, USER, "bill", "b1")).status, "unpublished");
  const s2 = (await prepareChainWrite(deps, USER, "bill", "b1")).sign!;
  await submitChainWrite(deps, USER, "bill", "b1", ownerSign(s2));
  await db.prepare("UPDATE bills SET status = 'paid', deposit_address = 'dep9' WHERE id = 'b1'").bind().run();
  await relayChain(deps, OWNER, "bill", "b1");
  assert.deepEqual(sent.map((s) => s.method), ["put_bill", "put_bill", "mark_bill_paid"]);
  assert.equal((await chainState(deps, USER, "bill", "b1")).synced, "paid");

  await db.prepare("INSERT INTO payees (id, owner, name, destination_asset, recipient_type, recipient, created_at) VALUES ('p1', ?, 'Ana', 'nep141:usdc', 'INTENTS', 'ana.near', ?)").bind(OWNER, NOW).run();
  const sp = (await prepareChainWrite(deps, USER, "payee", "p1")).sign!;
  assert.equal(sp.action, "put_payee");
  await submitChainWrite(deps, USER, "payee", "p1", ownerSign(sp));
  const rm = (await prepareChainWrite(deps, USER, "payee", "p1", "remove")).sign!;
  assert.equal(rm.action, "remove_payee");
  const removed = await removePayeeOnChain(deps, USER, "p1", ownerSign(rm));
  assert.equal(removed.ok, true);
  assert.ok(removed.tx);
  assert.equal(sent.at(-1)!.method, "remove_payee");
  assert.equal(sent.at(-1)!.args.payload, JSON.stringify({ id: "p1" }));
  // a payee that was never published is not sent
  await db.prepare("INSERT INTO payees (id, owner, name, destination_asset, recipient_type, recipient, created_at) VALUES ('p2', ?, 'Bo', 'nep141:usdc', 'INTENTS', 'bo.near', ?)").bind(OWNER, NOW).run();
  assert.equal((await removePayeeOnChain(deps, USER, "p2", ownerSign(rm))).ok, false);
  assert.equal(sent.at(-1)!.args.payload, JSON.stringify({ id: "p1" }));
});

test("payroll: batch published once, then each sent line is marked paid by the relayer", async () => {
  const db = createTestDb();
  await db.prepare("INSERT INTO payroll_batches (id, owner, title, origin_asset, created_at) VALUES ('B1', ?, 'March', 'nep141:usdc', ?)").bind(OWNER, NOW).run();
  for (const n of [1, 2])
    await db.prepare("INSERT INTO payroll_lines (batch_id, n, name, destination_asset, recipient_type, recipient, amount, deposit_address) VALUES ('B1', ?, ?, 'nep141:usdc', 'INTENTS', ?, '5', ?)")
      .bind(n, `P${n}`, `p${n}.near`, `dep-${n}`).run();
  const { rpc, sent } = fakeRpc();
  const deps = depsOf(db, rpc);
  const s = (await prepareChainWrite(deps, USER, "batch", "B1")).sign!;
  assert.equal(s.action, "put_batch");
  assert.equal(JSON.parse(s.payload).lines.length, 2);
  const v = await submitChainWrite(deps, USER, "batch", "B1", ownerSign(s));
  assert.deepEqual([v.status, v.lines?.paid], ["confirmed", 0]);
  await db.prepare(
    "INSERT INTO withdrawals (deposit_address, owner, origin_asset, destination_asset, amount, recipient, status, created_at, updated_at, kind, batch_id) VALUES ('dep-2', ?, 'a', 'b', '5', 'p2.near', 'SUCCESS', ?, ?, 'payroll', 'B1')",
  ).bind(OWNER, NOW, NOW).run();
  await relayChain(deps, OWNER, "batch", "B1");
  assert.deepEqual(sent.map((x) => x.method), ["put_batch", "mark_payroll_line_paid"]);
  assert.deepEqual(sent[1]!.args, { batch_id: "B1", n: 2, deposit_address: "dep-2", tx_hash: null });
  const after = await chainState(deps, USER, "batch", "B1");
  assert.deepEqual([after.status, after.lines?.paid, after.lines?.total], ["confirmed", 1, 2]);
});

test("pay-link fallback maps the contract record and refuses unknown tokens", async () => {
  const rec = {
    public_id: "A".repeat(22), owner: OWNER, status: "issued", number: "INV-1", issuer: "Example Studio", client: "Demo Client", due_date: "2030-01-31",
    token_id: SETTLEMENT_TOKENS[0].tokenId, total: "3000000", notes: "", items: [{ description: "Design", quantity: "2", unit_price: "1.5" }],
  };
  const read = { network: "mainnet" as const, rpcUrl: "x", contractId: CONTRACT };
  const p = await publicInvoiceFromChain(read, { view: async <T>() => rec as T }, rec.public_id);
  assert.equal(p?.source, "chain");
  assert.equal(p?.payTo, OWNER);
  assert.equal(p?.totalFormatted, "3");
  assert.deepEqual(p?.data.items, [{ description: "Design", quantity: "2", unitPrice: "1.5" }]);
  assert.equal(await publicInvoiceFromChain(read, { view: async <T>() => ({ ...rec, token_id: "nep141:other" }) as T }, rec.public_id), null);
  assert.equal(await publicInvoiceFromChain(read, { view: async () => { throw new Error("down"); } }, rec.public_id), null);
  assert.equal(await publicInvoiceFromChain(read, { view: async <T>() => rec as T }, "bad id!"), null);
});

test("failureText pulls the contract panic message", () => {
  assert.equal(failureText({ ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: ERR_NONCE_USED" } } } }), "ERR_NONCE_USED");
  assert.equal(failureText({ ActionError: { kind: { FunctionCallError: { ExecutionError: "Exceeded the prepaid gas." } } } }), "Exceeded the prepaid gas.");
  assert.ok(new NonceError("x") instanceof Error);
});
