// On-chain public records: invoices, bills, payees and payroll batches mirrored to the FrenzyPay NEAR contract
// (contracts/frenzypay). D1 stays the source the app reads and the index; the contract is the public,
// permanent copy. Off unless CHAIN_WRITES_ENABLED=true and the contract/relayer variables are set; with it off
// nothing here touches D1 or the network.
//
// Record writes are owner-signed: the owner's wallet signs a NEP-413 message naming the action and the sha256 of
// the exact payload string, and the relayer (RELAYER_ACCOUNT_ID, signing with a function-call key) submits it
// and pays gas. mark_*_paid calls are relayer-only. A chain failure never blocks the app: the record keeps
// working from D1 and shows its on-chain status with a retry.
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { base58, base64 } from "@scure/base";
import { settlementToken } from "../shared/assets.ts";
import type { InvoiceRow, PublicInvoice } from "../shared/invoice.ts";
import { formatAmount } from "../shared/units.ts";
import { nep413Hash } from "./auth.ts";
import { getBill, type BillRow } from "./bills.ts";
import type { Db } from "./db.ts";
import type { Env } from "./env.ts";
import { HttpError } from "./http.ts";
import { getInvoice } from "./invoices.ts";
import { RPC_TIMEOUT_MS } from "./near-rpc.ts";

export type Network = "mainnet" | "testnet";
export type ChainKind = "invoice" | "bill" | "payee" | "batch";
export const CHAIN_KINDS: readonly ChainKind[] = ["invoice", "bill", "payee", "batch"];

/** Contract methods the relayer key may call; scripts/setup-mainnet.md grants exactly these. */
export const WRITE_METHODS = [
  "put_invoice", "cancel_invoice", "mark_invoice_paid", "put_bill", "cancel_bill", "mark_bill_paid",
  "put_payee", "remove_payee", "put_batch", "mark_payroll_line_paid",
] as const;

export type ChainReadConfig = { network: Network; rpcUrl: string; contractId: string };
export type ChainConfig = ChainReadConfig & { relayerId: string; relayerPublicKey: Uint8Array; relayerSeed: Uint8Array };

const set = (v: string | undefined): string | undefined => (v && v.trim() ? v.trim() : undefined);
export const networkOf = (env: Pick<Env, "NEAR_NETWORK">): Network => (set(env.NEAR_NETWORK) === "testnet" ? "testnet" : "mainnet");

export function explorerTxUrl(network: Network, tx: string): string {
  return `https://${network === "testnet" ? "testnet." : ""}nearblocks.io/txns/${encodeURIComponent(tx)}`;
}

/** Read-only access (pay-link fallback): only CONTRACT_ID is needed. */
export function chainReadConfig(env: Env): ChainReadConfig | null {
  const contractId = set(env.CONTRACT_ID);
  return contractId ? { network: networkOf(env), rpcUrl: env.NEAR_RPC_URL, contractId } : null;
}

const KEY_PREFIX = "ed25519:";

function decodeKey(v: string, lengths: number[]): Uint8Array | null {
  if (!v.startsWith(KEY_PREFIX)) return null;
  try {
    const b = base58.decode(v.slice(KEY_PREFIX.length));
    return lengths.includes(b.length) ? b : null;
  } catch {
    return null;
  }
}

/**
 * Write access: CHAIN_WRITES_ENABLED must be exactly "true" and CONTRACT_ID, RELAYER_ACCOUNT_ID,
 * RELAYER_PUBLIC_KEY and RELAYER_PRIVATE_KEY set, with the private key matching the public key. Anything
 * else is "off" (a mismatched key is logged without printing it).
 */
export function chainConfig(env: Env): ChainConfig | null {
  if (set(env.CHAIN_WRITES_ENABLED) !== "true") return null;
  const read = chainReadConfig(env);
  const relayerId = set(env.RELAYER_ACCOUNT_ID);
  const pub = set(env.RELAYER_PUBLIC_KEY);
  const priv = set(env.RELAYER_PRIVATE_KEY);
  if (!read || !relayerId || !pub || !priv) return null;
  const pk = decodeKey(pub, [32]);
  // near-cli stores secret||public (64 bytes); a bare 32-byte seed is accepted too.
  const sk = decodeKey(priv, [32, 64]);
  if (!pk || !sk) {
    console.error("chain: RELAYER_PUBLIC_KEY / RELAYER_PRIVATE_KEY are not ed25519 keys; on-chain writes are off");
    return null;
  }
  const seed = sk.slice(0, 32);
  if (bytesToHex(ed25519.getPublicKey(seed)) !== bytesToHex(pk)) {
    console.error("chain: RELAYER_PRIVATE_KEY does not match RELAYER_PUBLIC_KEY; on-chain writes are off");
    return null;
  }
  return { ...read, relayerId, relayerPublicKey: pk, relayerSeed: seed };
}

// --- payloads: the exact strings the owner signs and the contract parses ---

export const payloadHash = (payload: string): string => bytesToHex(sha256(new TextEncoder().encode(payload)));

/** Mirrors the contract: the NEP-413 `message` for `action` on `payload`. */
export function signedMessage(action: string, owner: string, payload: string): string {
  return `FrenzyPay public record\naction: ${action}\nowner: ${owner}\npayload_sha256: ${payloadHash(payload)}`;
}

/** Everything public about an issued invoice. The client email is never part of it. */
export function invoicePayload(i: InvoiceRow): string {
  const d = i.data;
  return JSON.stringify({
    public_id: i.publicId, number: d.number, issuer: d.issuer, client: d.client, due_date: d.dueDate, token_id: i.tokenId,
    total: i.total, notes: d.notes, items: d.items.map((l) => ({ description: l.description, quantity: l.quantity, unit_price: l.unitPrice })),
    created_at: i.createdAt, issued_at: i.issuedAt ?? "",
  });
}

export function billPayload(b: BillRow): string {
  return JSON.stringify({
    id: b.id, vendor: b.vendor, reference: b.reference, due_date: b.dueDate, destination_asset: b.destinationAsset,
    recipient_type: b.recipientType, recipient: b.recipient, amount: b.amount, source: b.source,
    vendor_public_id: b.vendorPublicId ?? null, created_at: b.createdAt,
  });
}

type PayeeRaw = { id: string; owner: string; name: string; destination_asset: string; recipient_type: string; recipient: string; created_at: string };
export function payeePayload(p: PayeeRaw): string {
  return JSON.stringify({ id: p.id, name: p.name, destination_asset: p.destination_asset, recipient_type: p.recipient_type, recipient: p.recipient, created_at: p.created_at });
}

type BatchRaw = { id: string; owner: string; title: string; origin_asset: string; created_at: string };
type LineRaw = { n: number; name: string; destination_asset: string; recipient_type: string; recipient: string; amount: string };
export function batchPayload(b: BatchRaw, lines: LineRaw[]): string {
  return JSON.stringify({
    id: b.id, title: b.title, origin_asset: b.origin_asset, created_at: b.created_at,
    lines: lines.map((l) => ({ n: l.n, name: l.name, destination_asset: l.destination_asset, recipient_type: l.recipient_type, recipient: l.recipient, amount: l.amount })),
  });
}

// --- NEAR transactions (borsh) ---

class Borsh {
  private parts: Uint8Array[] = [];
  private n = 0;
  raw(b: Uint8Array): this {
    this.parts.push(b);
    this.n += b.length;
    return this;
  }
  u8(v: number): this {
    return this.raw(Uint8Array.of(v));
  }
  u32(v: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v, true);
    return this.raw(b);
  }
  u64(v: bigint): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, v, true);
    return this.raw(b);
  }
  u128(v: bigint): this {
    return this.u64(v & 0xffff_ffff_ffff_ffffn).u64(v >> 64n);
  }
  str(s: string): this {
    return this.bytes(new TextEncoder().encode(s));
  }
  bytes(b: Uint8Array): this {
    return this.u32(b.length).raw(b);
  }
  out(): Uint8Array {
    const o = new Uint8Array(this.n);
    let off = 0;
    for (const p of this.parts) {
      o.set(p, off);
      off += p.length;
    }
    return o;
  }
}

export type FunctionCallTx = {
  signerId: string; publicKey: Uint8Array; nonce: bigint; receiverId: string; blockHash: Uint8Array;
  method: string; args: Uint8Array; gas: bigint; deposit: bigint;
};

/** borsh(Transaction V0) with a single FunctionCall action (Action enum index 2, ed25519 key type 0). */
export function encodeTransaction(t: FunctionCallTx): Uint8Array {
  return new Borsh()
    .str(t.signerId)
    .u8(0).raw(t.publicKey)
    .u64(t.nonce)
    .str(t.receiverId)
    .raw(t.blockHash)
    .u32(1)
    .u8(2).str(t.method).bytes(t.args).u64(t.gas).u128(t.deposit)
    .out();
}

/** The signed transaction (base64) and its hash (base58 sha256 of the unsigned bytes), as NEAR computes it. */
export function signTransaction(t: FunctionCallTx, seed: Uint8Array): { signedB64: string; hash: string } {
  const bytes = encodeTransaction(t);
  const digest = sha256(bytes);
  const sig = ed25519.sign(digest, seed);
  return { signedB64: base64.encode(new Borsh().raw(bytes).u8(0).raw(sig).out()), hash: base58.encode(digest) };
}

// --- RPC ---

export type TxResult = { state: "success" } | { state: "failure"; error: string } | { state: "unknown" };
export type AccessKeyInfo = { nonce: bigint; blockHash: Uint8Array; permission: unknown };
export type ChainRpc = {
  accessKey(account: string, publicKey: string): Promise<AccessKeyInfo | null>;
  sendTx(signedB64: string): Promise<TxResult>;
  txStatus(hash: string, sender: string): Promise<TxResult>;
  view<T>(contract: string, method: string, args: object): Promise<T>;
};

/** A stale access-key nonce: fetch the key again and re-sign. */
export class NonceError extends Error {}

type RpcBody = { result?: Record<string, unknown>; error?: { name?: string; cause?: { name?: string; info?: unknown }; data?: unknown } };

function outcomeOf(result: Record<string, unknown>): TxResult {
  const st = result.status;
  if (st && typeof st === "object") {
    if ("SuccessValue" in st) return { state: "success" };
    if ("Failure" in st) return { state: "failure", error: failureText((st as { Failure: unknown }).Failure) };
  }
  return { state: "unknown" };
}

/** The contract's panic message (ERR_…) when there is one, else a short JSON of the failure. */
export function failureText(f: unknown): string {
  const s = JSON.stringify(f) ?? "";
  const m = /Smart contract panicked: ([^"\\]+)/.exec(s) ?? /"ExecutionError":"([^"\\]+)/.exec(s);
  return (m ? m[1]! : s).slice(0, 200);
}

export function createChainRpc(url: string, fetchFn: typeof fetch): ChainRpc {
  async function call(method: string, params: unknown, timeoutMs = RPC_TIMEOUT_MS): Promise<RpcBody> {
    // Called bare: workerd's fetch throws "Illegal invocation" when called as a method.
    const res = await fetchFn(url, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "frenzypay", method, params }),
    });
    if (res.status === 408) return { error: { cause: { name: "TIMEOUT_ERROR" } } };
    if (!res.ok) throw new Error(`NEAR RPC HTTP ${res.status}`);
    return (await res.json()) as RpcBody;
  }
  const errName = (b: RpcBody) => String(b.error?.cause?.name ?? b.error?.name ?? "unknown");
  return {
    async accessKey(account, publicKey) {
      const b = await call("query", { request_type: "view_access_key", finality: "final", account_id: account, public_key: publicKey });
      if (b.error) {
        if (["UNKNOWN_ACCESS_KEY", "UNKNOWN_ACCOUNT"].includes(errName(b))) return null;
        throw new Error(`NEAR RPC error ${errName(b)}`);
      }
      const r = b.result ?? {};
      if (typeof r.error === "string") {
        if (/does not exist/.test(r.error)) return null;
        throw new Error("NEAR RPC query error");
      }
      if (typeof r.block_hash !== "string" || (typeof r.nonce !== "number" && typeof r.nonce !== "string")) throw new Error("NEAR RPC returned no access key");
      return { nonce: BigInt(r.nonce), blockHash: base58.decode(r.block_hash), permission: r.permission };
    },
    async sendTx(signedB64) {
      let b: RpcBody;
      try {
        b = await call("send_tx", { signed_tx_base64: signedB64, wait_until: "EXECUTED_OPTIMISTIC" });
      } catch (e) {
        // Sent, but no answer in time: the transaction may still land. The hash is already recorded.
        if ((e as Error)?.name === "TimeoutError") return { state: "unknown" };
        throw e;
      }
      if (b.error) {
        const name = errName(b);
        if (name === "TIMEOUT_ERROR") return { state: "unknown" };
        const detail = JSON.stringify(b.error.data ?? b.error.cause?.info ?? "") ?? "";
        if (/InvalidNonce/.test(detail)) throw new NonceError("stale access key nonce");
        return { state: "failure", error: `${name}: ${detail}`.slice(0, 200) };
      }
      return outcomeOf(b.result ?? {});
    },
    async txStatus(hash, sender) {
      let b: RpcBody;
      try {
        b = await call("tx", { tx_hash: hash, sender_account_id: sender, wait_until: "EXECUTED_OPTIMISTIC" }, 8_000);
      } catch (e) {
        if ((e as Error)?.name === "TimeoutError") return { state: "unknown" };
        throw e;
      }
      if (b.error) {
        const name = errName(b);
        if (name === "UNKNOWN_TRANSACTION" || name === "TIMEOUT_ERROR") return { state: "unknown" };
        throw new Error(`NEAR RPC error ${name}`);
      }
      return outcomeOf(b.result ?? {});
    },
    async view<T>(contract: string, method: string, args: object): Promise<T> {
      const b = await call("query", {
        request_type: "call_function", finality: "final", account_id: contract, method_name: method,
        args_base64: base64.encode(new TextEncoder().encode(JSON.stringify(args))),
      });
      if (b.error) throw new Error(`NEAR RPC error ${errName(b)}`);
      const bytes = b.result?.result;
      if (!Array.isArray(bytes)) throw new Error("NEAR RPC call_function returned no bytes");
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes as number[]))) as T;
    },
  };
}

// --- per-record state ---

export type ChainDeps = { db: Db; cfg: ChainConfig; rpc: ChainRpc; now: Date };

export function chainDeps(env: Env): ChainDeps | null {
  const cfg = chainConfig(env);
  return cfg ? { db: env.DB, cfg, rpc: createChainRpc(cfg.rpcUrl, (i, init) => fetch(i, init)), now: new Date() } : null;
}

/** A pending write with no outcome after this long is treated as lost (it can be retried). */
export const STALE_PENDING_MS = 10 * 60 * 1000;
const GAS = 150_000_000_000_000n;
const MAX_LINE_MARKS = 5;

type Cols = { chain_status: string | null; chain_tx: string | null; chain_error: string | null; chain_synced: string | null; chain_at: string | null };
type Stored = { method: string; args: Record<string, unknown>; onConfirm: string; signed: boolean };
type SignedOp = { signed: true; method: string; payload: string; onConfirm: string };
type RelayOp = { signed: false; method: string; args: Record<string, unknown>; onConfirm: string; line?: number };
type Op = SignedOp | RelayOp;
/** Where an op's status lives: the record row, or one payroll line. */
type Target = { table: string; where: string; keys: unknown[] };

type Loaded = {
  owner: string;
  row: Target;
  cols: Cols & { chain_payload: string | null };
  /** The next owner-signed write, if the chain is behind D1 and needs one. */
  signed: SignedOp | null;
  /** Relayer-only writes that are due now (mark paid), with the row each one updates. */
  relays: { op: RelayOp; target: Target; cols: Cols }[];
  lines?: { total: number; paid: number; pending: number; failed: number };
};

const CHAIN_COLS = "chain_status, chain_tx, chain_error, chain_synced, chain_at";
const notFound = () => new HttpError(404, "Record not found");

async function chainCols(db: Db, table: string, where: string, keys: unknown[]): Promise<Cols & { chain_payload: string | null }> {
  const r = await db.prepare(`SELECT ${CHAIN_COLS}, chain_payload FROM ${table} WHERE ${where}`).bind(...keys).first<Cols & { chain_payload: string | null }>();
  if (!r) throw notFound();
  return { ...r };
}

async function destinationTx(db: Db, table: "payment_attempts" | "withdrawals", depositAddress: string | undefined): Promise<string | null> {
  if (!depositAddress) return null;
  const r = await db
    .prepare(`SELECT json_extract(upstream, '$.destinationTxHashes[0]') AS h FROM ${table} WHERE deposit_address = ? AND json_valid(COALESCE(upstream, '{}'))`)
    .bind(depositAddress)
    .first<{ h: string | null }>();
  return typeof r?.h === "string" && r.h ? r.h.slice(0, 200) : null;
}

async function loadInvoice(db: Db, owner: string, id: string): Promise<Loaded> {
  const inv = await getInvoice(db, owner, id);
  const row: Target = { table: "invoices", where: "id = ? AND owner = ?", keys: [inv.id, owner] };
  const cols = await chainCols(db, row.table, row.where, row.keys);
  const synced = cols.chain_synced;
  let signed: SignedOp | null = null;
  const relays: Loaded["relays"] = [];
  if (inv.status === "issued" || inv.status === "paid") {
    if (!synced) signed = { signed: true, method: "put_invoice", payload: invoicePayload(inv), onConfirm: "issued" };
    else if (inv.status === "paid" && synced === "issued" && inv.paidBy) {
      const tx = await destinationTx(db, "payment_attempts", inv.paidBy);
      relays.push({ op: { signed: false, method: "mark_invoice_paid", args: { public_id: inv.publicId, deposit_address: inv.paidBy, tx_hash: tx }, onConfirm: "paid" }, target: row, cols });
    }
  } else if (inv.status === "cancelled" && synced === "issued") {
    signed = { signed: true, method: "cancel_invoice", payload: JSON.stringify({ public_id: inv.publicId }), onConfirm: "cancelled" };
  }
  return { owner, row, cols, signed, relays };
}

async function loadBill(db: Db, owner: string, id: string): Promise<Loaded> {
  const bill = await getBill(db, owner, id);
  const row: Target = { table: "bills", where: "id = ? AND owner = ?", keys: [bill.id, owner] };
  const cols = await chainCols(db, row.table, row.where, row.keys);
  const synced = cols.chain_synced;
  const payload = billPayload(bill);
  const current = `scheduled:${payloadHash(payload)}`;
  const put: SignedOp = { signed: true, method: "put_bill", payload, onConfirm: current };
  let signed: SignedOp | null = null;
  const relays: Loaded["relays"] = [];
  if (bill.status === "scheduled" || bill.status === "paying") {
    if (synced !== current && synced !== "paid" && synced !== "cancelled") signed = put;
  } else if (bill.status === "paid") {
    if (synced === current) {
      const tx = await destinationTx(db, "withdrawals", bill.depositAddress);
      relays.push({ op: { signed: false, method: "mark_bill_paid", args: { id: bill.id, deposit_address: bill.depositAddress ?? "", tx_hash: tx }, onConfirm: "paid" }, target: row, cols });
    } else if (synced !== "paid" && synced !== "cancelled") signed = put;
  } else if (bill.status === "cancelled" && synced?.startsWith("scheduled:")) {
    signed = { signed: true, method: "cancel_bill", payload: JSON.stringify({ id: bill.id }), onConfirm: "cancelled" };
  }
  return { owner, row, cols, signed, relays };
}

async function loadPayee(db: Db, owner: string, id: string): Promise<Loaded & { raw: PayeeRaw }> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw notFound();
  const raw = await db.prepare(`SELECT id, owner, name, destination_asset, recipient_type, recipient, created_at FROM payees WHERE id = ? AND owner = ?`).bind(id, owner).first<PayeeRaw>();
  if (!raw) throw notFound();
  const row: Target = { table: "payees", where: "id = ? AND owner = ?", keys: [id, owner] };
  const cols = await chainCols(db, row.table, row.where, row.keys);
  const payload = payeePayload(raw);
  const current = `saved:${payloadHash(payload)}`;
  const signed: SignedOp | null = cols.chain_synced === current ? null : { signed: true, method: "put_payee", payload, onConfirm: current };
  return { owner, row, cols, signed, relays: [], raw: { ...raw } };
}

type LineJoin = LineRaw & Cols & { w_status: string | null; deposit_address: string | null; tx: string | null };

async function loadBatch(db: Db, owner: string, id: string): Promise<Loaded> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw notFound();
  const b = await db.prepare(`SELECT id, owner, title, origin_asset, created_at FROM payroll_batches WHERE id = ? AND owner = ?`).bind(id, owner).first<BatchRaw>();
  if (!b) throw notFound();
  const row: Target = { table: "payroll_batches", where: "id = ? AND owner = ?", keys: [id, owner] };
  const cols = await chainCols(db, row.table, row.where, row.keys);
  const { results } = await db
    .prepare(
      `SELECT l.n AS n, l.name AS name, l.destination_asset AS destination_asset, l.recipient_type AS recipient_type, l.recipient AS recipient,
              l.amount AS amount, l.deposit_address AS deposit_address, l.chain_status AS chain_status, l.chain_tx AS chain_tx,
              l.chain_error AS chain_error, l.chain_synced AS chain_synced, l.chain_at AS chain_at, w.status AS w_status,
              CASE WHEN json_valid(COALESCE(w.upstream, '{}')) THEN json_extract(w.upstream, '$.destinationTxHashes[0]') END AS tx
       FROM payroll_lines l LEFT JOIN withdrawals w ON w.deposit_address = l.deposit_address AND w.owner = ?
       WHERE l.batch_id = ? ORDER BY l.n`,
    )
    .bind(owner, id)
    .all<LineJoin>();
  const lines = results.map((l) => ({ ...l }));
  const created = cols.chain_synced === "created";
  const relays: Loaded["relays"] = [];
  if (created) {
    for (const l of lines) {
      if (l.w_status !== "SUCCESS" || l.chain_synced === "paid" || !l.deposit_address) continue;
      relays.push({
        op: { signed: false, method: "mark_payroll_line_paid", args: { batch_id: id, n: l.n, deposit_address: l.deposit_address, tx_hash: typeof l.tx === "string" ? l.tx.slice(0, 200) : null }, onConfirm: "paid", line: l.n },
        target: { table: "payroll_lines", where: "batch_id = ? AND n = ?", keys: [id, l.n] },
        cols: l,
      });
    }
  }
  return {
    owner, row, cols, relays,
    signed: created ? null : { signed: true, method: "put_batch", payload: batchPayload(b, lines), onConfirm: "created" },
    lines: {
      total: lines.length,
      paid: lines.filter((l) => l.chain_synced === "paid").length,
      pending: lines.filter((l) => l.chain_status === "pending").length,
      failed: lines.filter((l) => l.chain_status === "failed" && l.chain_synced !== "paid").length,
    },
  };
}

function load(db: Db, owner: string, kind: ChainKind, id: string): Promise<Loaded> {
  if (kind === "invoice") return loadInvoice(db, owner, id);
  if (kind === "bill") return loadBill(db, owner, id);
  if (kind === "payee") return loadPayee(db, owner, id);
  return loadBatch(db, owner, id);
}

export function parseKind(v: unknown): ChainKind {
  if (!(CHAIN_KINDS as readonly unknown[]).includes(v)) throw new HttpError(404, "Unknown record type");
  return v as ChainKind;
}

const isStale = (c: Cols, now: Date) => !c.chain_at || now.getTime() - Date.parse(c.chain_at) > STALE_PENDING_MS;
const freshPending = (c: Cols, now: Date) => c.chain_status === "pending" && !isStale(c, now);

/** Take the row for one write: false when another request has a fresh write in flight for it. */
async function claim(deps: ChainDeps, t: Target, stored: Stored | null): Promise<boolean> {
  const at = deps.now.toISOString();
  const stale = new Date(deps.now.getTime() - STALE_PENDING_MS).toISOString();
  const payloadSet = t.table === "payroll_lines" ? "" : ", chain_payload = ?";
  const r = await deps.db
    .prepare(
      `UPDATE ${t.table} SET chain_status = 'pending', chain_tx = NULL, chain_error = NULL, chain_at = ?${payloadSet}
       WHERE ${t.where} AND (chain_status IS NULL OR chain_status != 'pending' OR chain_at IS NULL OR chain_at < ?)`,
    )
    .bind(at, ...(payloadSet ? [stored ? JSON.stringify(stored) : null] : []), ...t.keys, stale)
    .run();
  return r.meta.changes === 1;
}

async function record(deps: ChainDeps, t: Target, f: { status: "pending" | "confirmed" | "failed"; tx?: string | null; error?: string | null; synced?: string; clearPayload?: boolean }): Promise<void> {
  const sets = ["chain_status = ?", "chain_at = ?"];
  const vals: unknown[] = [f.status, deps.now.toISOString()];
  if (f.tx !== undefined) {
    sets.push("chain_tx = ?");
    vals.push(f.tx);
  }
  sets.push("chain_error = ?");
  vals.push(f.error ?? null);
  if (f.synced !== undefined) {
    sets.push("chain_synced = ?");
    vals.push(f.synced);
  }
  if (f.clearPayload && t.table !== "payroll_lines") sets.push("chain_payload = NULL");
  await deps.db.prepare(`UPDATE ${t.table} SET ${sets.join(", ")} WHERE ${t.where}`).bind(...vals, ...t.keys).run();
}

/** Sign and send one function call as the relayer. Retries once on a stale access-key nonce. */
async function send(deps: ChainDeps, method: string, args: Record<string, unknown>): Promise<{ hash: string; result: TxResult }> {
  const { cfg, rpc } = deps;
  const pk = KEY_PREFIX + base58.encode(cfg.relayerPublicKey);
  for (let attempt = 0; ; attempt++) {
    const ak = await rpc.accessKey(cfg.relayerId, pk);
    if (!ak) throw new Error("The relayer key is not on the relayer account");
    const { signedB64, hash } = signTransaction(
      {
        signerId: cfg.relayerId, publicKey: cfg.relayerPublicKey, nonce: ak.nonce + 1n, receiverId: cfg.contractId, blockHash: ak.blockHash,
        method, args: new TextEncoder().encode(JSON.stringify(args)), gas: GAS, deposit: 0n,
      },
      cfg.relayerSeed,
    );
    try {
      return { hash, result: await rpc.sendTx(signedB64) };
    } catch (e) {
      if (e instanceof NonceError && attempt < 2) continue;
      throw e;
    }
  }
}

/** After a failure: does the contract already hold what this write wanted (an earlier attempt landed)? */
async function alreadyOnChain(deps: ChainDeps, s: Stored): Promise<boolean> {
  try {
    const c = deps.cfg.contractId;
    const a = s.args;
    const payload = typeof a.payload === "string" ? (JSON.parse(a.payload) as Record<string, unknown>) : a;
    if (s.method === "put_invoice" || s.method === "cancel_invoice" || s.method === "mark_invoice_paid") {
      const v = await deps.rpc.view<{ status?: string } | null>(c, "get_invoice", { public_id: payload.public_id });
      return !!v && (s.onConfirm === "issued" || v.status === s.onConfirm);
    }
    if (s.method === "cancel_bill" || s.method === "mark_bill_paid") {
      const v = await deps.rpc.view<{ status?: string } | null>(c, "get_bill", { id: payload.id });
      return !!v && v.status === s.onConfirm;
    }
    if (s.method === "put_batch") return !!(await deps.rpc.view<unknown>(c, "get_batch", { id: payload.id }));
    if (s.method === "mark_payroll_line_paid") {
      const v = await deps.rpc.view<{ lines?: { n: number; paid_at_ms?: number | null }[] } | null>(c, "get_batch", { id: payload.batch_id });
      return !!v?.lines?.some((l) => l.n === payload.n && l.paid_at_ms != null);
    }
  } catch {
    /* unknown: report the failure */
  }
  return false;
}

/** Run one claimed write to an outcome and record it. Never throws. */
async function execute(deps: ChainDeps, t: Target, s: Stored): Promise<void> {
  let sent: { hash: string; result: TxResult };
  try {
    sent = await send(deps, s.method, s.args);
  } catch (e) {
    console.warn(`chain: ${s.method} not sent: ${(e as Error)?.message ?? "error"}`);
    // Nothing reached the chain; an owner-signed payload stays stored so Retry needs no new signature.
    await record(deps, t, { status: "failed", tx: null, error: "NEAR RPC is unavailable. Try again later." }).catch(() => {});
    return;
  }
  await settle(deps, t, s, sent.hash, sent.result);
}

async function settle(deps: ChainDeps, t: Target, s: Stored, hash: string, result: TxResult): Promise<void> {
  try {
    if (result.state === "success") await record(deps, t, { status: "confirmed", tx: hash, synced: s.onConfirm, clearPayload: true });
    else if (result.state === "unknown") await record(deps, t, { status: "pending", tx: hash });
    else if (await alreadyOnChain(deps, s)) await record(deps, t, { status: "confirmed", tx: hash, synced: s.onConfirm, clearPayload: true });
    // The contract refused it, so the signature was not used up, but the same payload would fail the same way:
    // the next attempt starts from a fresh owner signature.
    else await record(deps, t, { status: "failed", tx: hash, error: result.error, clearPayload: true });
  } catch (e) {
    console.warn(`chain: could not record ${s.method} outcome: ${(e as Error)?.message ?? "error"}`);
  }
}

const storedOf = (raw: string | null): Stored | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Stored;
  } catch {
    return null;
  }
};

/** Settle writes left pending: ask the RPC about their transaction, or give up on them after STALE_PENDING_MS. */
async function refreshPending(deps: ChainDeps, l: Loaded): Promise<boolean> {
  const rows: { t: Target; cols: Cols; stored: Stored | null }[] = [{ t: l.row, cols: l.cols, stored: storedOf(l.cols.chain_payload) }];
  for (const r of l.relays) rows.push({ t: r.target, cols: r.cols, stored: r.op.line !== undefined ? { method: r.op.method, args: r.op.args, onConfirm: "paid", signed: false } : null });
  let changed = false;
  for (const { t, cols, stored } of rows) {
    if (cols.chain_status !== "pending") continue;
    if (!cols.chain_tx) {
      // Claimed but never sent (the request died): free it once stale.
      if (isStale(cols, deps.now)) {
        await record(deps, t, { status: "failed", error: "The write did not complete. Try again." });
        changed = true;
      }
      continue;
    }
    let r: TxResult;
    try {
      r = await deps.rpc.txStatus(cols.chain_tx, deps.cfg.relayerId);
    } catch {
      continue;
    }
    if (r.state === "unknown") {
      if (isStale(cols, deps.now)) {
        await record(deps, t, { status: "failed", error: "The transaction was not found on chain. Try again." });
        changed = true;
      }
      continue;
    }
    // A pending row without its payload (a relay op since recomputed) still knows what it was for via the loaded op.
    const s = stored ?? l.relays.find((x) => x.target === t)?.op;
    if (!s) continue;
    await settle(deps, t, { method: s.method, args: s.args, onConfirm: s.onConfirm, signed: false }, cols.chain_tx, r);
    changed = true;
  }
  return changed;
}

/** Run every due relayer-only write (mark paid). Skips rows with a fresh write in flight. */
async function runRelays(deps: ChainDeps, l: Loaded): Promise<boolean> {
  let ran = false;
  for (const { op, target, cols } of l.relays.slice(0, MAX_LINE_MARKS)) {
    if (freshPending(cols, deps.now)) continue;
    const stored: Stored = { method: op.method, args: op.args, onConfirm: op.onConfirm, signed: false };
    if (!(await claim(deps, target, stored))) continue;
    await execute(deps, target, stored);
    ran = true;
  }
  return ran;
}

// --- public API ---

export type ChainStatus = "none" | "unpublished" | "pending" | "confirmed" | "failed" | "unavailable";
export type ChainView = {
  status: ChainStatus;
  network: Network;
  contractId: string;
  /** What the contract holds for this record, e.g. "issued", "paid", "created". */
  synced?: string;
  tx?: string;
  txUrl?: string;
  error?: string;
  /** The owner can publish (or re-publish) by signing in their NEAR wallet. */
  canPublish: boolean;
  /** Payroll: how many paid lines the contract already shows as paid. */
  lines?: { total: number; paid: number; pending: number; failed: number };
};

type User = { account: string; kind: "near" | "evm" };

function view(deps: ChainDeps, user: User, l: Loaded): ChainView {
  const c = l.cols;
  const base = { network: deps.cfg.network, contractId: deps.cfg.contractId, ...(l.lines ? { lines: l.lines } : {}) };
  const synced = c.chain_synced ? { synced: c.chain_synced.replace(/:.*$/, "") } : {};
  const tx = c.chain_tx ? { tx: c.chain_tx, txUrl: explorerTxUrl(deps.cfg.network, c.chain_tx) } : {};
  const lineFailed = l.relays.some((r) => r.cols.chain_status === "failed");
  const linePending = l.relays.some((r) => r.cols.chain_status === "pending");
  if (c.chain_status === "pending") return { ...base, ...synced, ...tx, status: "pending", canPublish: false };
  if (l.signed && user.kind !== "near") return { ...base, ...synced, ...tx, status: "unavailable", canPublish: false };
  if (c.chain_status === "failed" && (l.signed || l.relays.length))
    return { ...base, ...synced, ...tx, status: "failed", error: c.chain_error ?? "The last write failed.", canPublish: true };
  if (l.signed) return { ...base, ...synced, ...tx, status: "unpublished", canPublish: true };
  if (linePending) return { ...base, ...synced, ...tx, status: "pending", canPublish: false };
  if (lineFailed) {
    const err = l.relays.find((r) => r.cols.chain_status === "failed")?.cols.chain_error;
    return { ...base, ...synced, ...tx, status: "failed", error: err ?? "Marking a paid line failed.", canPublish: true };
  }
  if (l.relays.length) return { ...base, ...synced, ...tx, status: "pending", canPublish: false };
  if (c.chain_synced) return { ...base, ...synced, ...tx, status: "confirmed", canPublish: false };
  return { ...base, status: "none", canPublish: false };
}

/** The record's on-chain status, after settling pending writes and running due mark-paid writes. */
export async function chainState(deps: ChainDeps, user: User, kind: ChainKind, id: string): Promise<ChainView> {
  let l = await load(deps.db, user.account, kind, id);
  if (await refreshPending(deps, l)) l = await load(deps.db, user.account, kind, id);
  if (await runRelays(deps, l)) l = await load(deps.db, user.account, kind, id);
  return view(deps, user, l);
}

/** What the owner's wallet signs (NEP-413): `nonce` is base64 of 32 bytes, `recipient` the contract. */
export type SignRequest = { action: string; payload: string; message: string; recipient: string; nonce: string };

/**
 * Start a publish or retry. A stored owner-signed payload that matches the record (left by a transport failure)
 * is resubmitted as is; due mark-paid writes run directly; otherwise returns what the owner must sign.
 */
export async function prepareChainWrite(deps: ChainDeps, user: User, kind: ChainKind, id: string, action?: "remove"): Promise<{ state: ChainView; sign?: SignRequest }> {
  if (action === "remove") {
    if (kind !== "payee") throw new HttpError(400, "Only payees can be removed");
    const p = await loadPayee(deps.db, user.account, id);
    if (!p.cols.chain_synced) throw new HttpError(409, "This payee is not on-chain");
    return { state: view(deps, user, p), sign: signRequest(deps, user, { signed: true, method: "remove_payee", payload: JSON.stringify({ id }), onConfirm: "" }) };
  }
  const l = await load(deps.db, user.account, kind, id);
  if (freshPending(l.cols, deps.now)) return { state: view(deps, user, l) };
  if (l.signed) {
    if (user.kind !== "near") throw new HttpError(409, "On-chain records are signed with a NEAR wallet. Sign in with NEAR to publish.");
    const stored = storedOf(l.cols.chain_payload);
    if (l.cols.chain_status === "failed" && stored?.signed && stored.method === l.signed.method && stored.args.payload === l.signed.payload) {
      if (await claim(deps, l.row, stored)) await execute(deps, l.row, stored);
      return { state: view(deps, user, await load(deps.db, user.account, kind, id)) };
    }
    return { state: view(deps, user, l), sign: signRequest(deps, user, l.signed) };
  }
  if (await runRelays(deps, l)) return { state: view(deps, user, await load(deps.db, user.account, kind, id)) };
  return { state: view(deps, user, l) };
}

function signRequest(deps: ChainDeps, user: User, op: SignedOp): SignRequest {
  return {
    action: op.method, payload: op.payload, message: signedMessage(op.method, user.account, op.payload), recipient: deps.cfg.contractId,
    nonce: base64.encode(crypto.getRandomValues(new Uint8Array(32))),
  };
}

export type SignedBody = { nonce?: unknown; publicKey?: unknown; signature?: unknown };

/**
 * Check an owner signature over `op` and build the contract `auth`. The signature is verified here first so a
 * bad one never costs gas; the key must be a full-access key of the owner (checked over RPC) unless the
 * contract already has it registered for the owner, in which case the relayer does not attest it again.
 */
async function authFor(deps: ChainDeps, user: User, op: SignedOp, body: SignedBody): Promise<Record<string, unknown>> {
  const bad = () => new HttpError(400, "The wallet signature does not match this record. Sign again.");
  const { nonce, publicKey, signature } = body ?? {};
  if (typeof nonce !== "string" || typeof publicKey !== "string" || typeof signature !== "string") throw bad();
  let n: Uint8Array, sig: Uint8Array;
  try {
    n = base64.decode(nonce);
    sig = base64.decode(signature);
  } catch {
    throw bad();
  }
  const pk = decodeKey(publicKey, [32]);
  if (!pk || n.length !== 32 || sig.length !== 64) throw bad();
  const hash = nep413Hash({ message: signedMessage(op.method, user.account, op.payload), nonce: n, recipient: deps.cfg.contractId, callbackUrl: null });
  let ok = false;
  try {
    ok = ed25519.verify(sig, hash, pk);
  } catch {
    ok = false;
  }
  if (!ok) throw bad();
  let attest: boolean;
  try {
    const registered = await deps.rpc.view<unknown>(deps.cfg.contractId, "get_key", { owner: user.account, public_key: publicKey });
    if (registered) attest = false;
    else {
      const key = await deps.rpc.accessKey(user.account, publicKey);
      if (!key || key.permission !== "FullAccess") throw new HttpError(403, "Sign with a full-access key of your NEAR account.");
      attest = true;
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(503, "NEAR RPC is unavailable. Try again later.");
  }
  return { owner: user.account, public_key: publicKey, nonce, signature, attest_key: attest };
}

/** Submit an owner-signed write for the record's current state. */
export async function submitChainWrite(deps: ChainDeps, user: User, kind: ChainKind, id: string, body: SignedBody): Promise<ChainView> {
  if (user.kind !== "near") throw new HttpError(409, "On-chain records are signed with a NEAR wallet. Sign in with NEAR to publish.");
  const l = await load(deps.db, user.account, kind, id);
  if (!l.signed) return view(deps, user, l);
  const auth = await authFor(deps, user, l.signed, body);
  const stored: Stored = { method: l.signed.method, args: { payload: l.signed.payload, auth }, onConfirm: l.signed.onConfirm, signed: true };
  if (!(await claim(deps, l.row, stored))) throw new HttpError(409, "A write for this record is already in progress.");
  await execute(deps, l.row, stored);
  return chainState(deps, user, kind, id);
}

/**
 * Remove a published payee from the contract before it is deleted from D1. Best effort: the result is
 * returned, never thrown, because deleting the payee must not depend on the chain.
 */
export async function removePayeeOnChain(deps: ChainDeps, user: User, id: string, body: SignedBody): Promise<{ ok: boolean; tx?: string; error?: string }> {
  try {
    if (user.kind !== "near") return { ok: false, error: "Needs a NEAR wallet" };
    // Only the owner's own payee that is actually on-chain is worth relayer gas.
    const p = await loadPayee(deps.db, user.account, id);
    if (!p.cols.chain_synced) return { ok: false, error: "This payee is not on-chain" };
    const op: SignedOp = { signed: true, method: "remove_payee", payload: JSON.stringify({ id }), onConfirm: "" };
    const auth = await authFor(deps, user, op, body);
    const sent = await send(deps, op.method, { payload: op.payload, auth });
    if (sent.result.state === "failure") return { ok: false, tx: sent.hash, error: sent.result.error };
    return { ok: true, tx: sent.hash };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "error" };
  }
}

/**
 * Hook for flows that may have made a record paid (payment reconciliation, bill and payroll refresh): settle
 * pending writes and run due mark-paid writes. No-op without chain config; never throws.
 */
export async function relayChain(deps: ChainDeps | null, owner: string, kind: ChainKind, id: string): Promise<void> {
  if (!deps) return;
  try {
    const l = await load(deps.db, owner, kind, id);
    if (!l.relays.length && l.cols.chain_status !== "pending") return;
    await runRelays(deps, (await refreshPending(deps, l)) ? await load(deps.db, owner, kind, id) : l);
  } catch (e) {
    console.warn(`chain: relay for ${kind} failed: ${(e as Error)?.message ?? "error"}`);
  }
}

// --- public pay-link fallback ---

type ChainInvoice = {
  public_id: string; owner: string; status: string; number: string; issuer: string; client: string; due_date: string; token_id: string;
  total: string; notes: string; items: { description: string; quantity: string; unit_price: string }[];
};

/** The public invoice as the contract holds it, for a pay link D1 does not know. Null when absent or unreadable. */
export async function publicInvoiceFromChain(cfg: ChainReadConfig, rpc: Pick<ChainRpc, "view">, publicId: string): Promise<PublicInvoice | null> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(publicId)) return null;
  let v: ChainInvoice | null;
  try {
    v = await rpc.view<ChainInvoice | null>(cfg.contractId, "get_invoice", { public_id: publicId });
  } catch {
    return null;
  }
  if (!v || !["issued", "paid", "cancelled"].includes(v.status)) return null;
  let token: ReturnType<typeof settlementToken>;
  try {
    token = settlementToken(v.token_id);
  } catch {
    return null;
  }
  const data = {
    number: v.number, client: v.client, issuer: v.issuer, dueDate: v.due_date, tokenId: v.token_id, notes: v.notes,
    items: v.items.map((i) => ({ description: i.description, quantity: i.quantity, unitPrice: i.unit_price })),
  };
  return {
    publicId: v.public_id, status: v.status as PublicInvoice["status"], tokenId: v.token_id, symbol: token.symbol, data,
    total: v.total, totalFormatted: formatAmount(BigInt(v.total), token.decimals), payTo: v.owner, dueDate: v.due_date, source: "chain",
  };
}
