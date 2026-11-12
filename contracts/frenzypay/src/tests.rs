use super::*;
use ed25519_dalek::{Signer, SigningKey, Verifier};
use near_sdk::base64::engine::general_purpose::STANDARD as B64;
use near_sdk::base64::Engine;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::testing_env;
use std::panic::{catch_unwind, AssertUnwindSafe};

const CONTRACT: &str = "frenzypay.maxkumbang.near";
const ADMIN: &str = "maxkumbang.near";
const RELAYER: &str = "relayer.near";
const ALICE: &str = "alice.near";
const BOB: &str = "bob.near";
const T0_MS: u64 = 1_760_000_000_000;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx_at(predecessor: &str, ms: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(CONTRACT))
        .predecessor_account_id(acc(predecessor))
        .signer_account_id(acc(predecessor))
        .block_timestamp(ms * 1_000_000);
    testing_env!(b.build());
}

fn ctx(predecessor: &str) {
    ctx_at(predecessor, T0_MS);
}

fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn pk(k: &SigningKey) -> String {
    format!("ed25519:{}", near_sdk::bs58::encode(k.verifying_key().to_bytes()).into_string())
}

// ---- independent NEP-413 implementation for the tests ----

fn borsh_string(out: &mut Vec<u8>, s: &str) {
    out.extend_from_slice(&(s.len() as u32).to_le_bytes());
    out.extend_from_slice(s.as_bytes());
}

fn test_message(action: &str, owner: &str, payload: &str) -> String {
    let digest: String = env::sha256(payload.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    format!("FrenzyPay public record\naction: {action}\nowner: {owner}\npayload_sha256: {digest}")
}

fn test_nep413_hash(message: &str, nonce: &[u8; 32], recipient: &str) -> Vec<u8> {
    let mut buf = Vec::new();
    buf.extend_from_slice(&2_147_484_061u32.to_le_bytes());
    borsh_string(&mut buf, message);
    buf.extend_from_slice(nonce);
    borsh_string(&mut buf, recipient);
    buf.push(0);
    env::sha256(&buf)
}

struct Fx {
    c: FrenzyPay,
    nonce_counter: u32,
}

impl Fx {
    fn new() -> Self {
        ctx(ADMIN);
        Fx { c: FrenzyPay::new(acc(ADMIN), acc(RELAYER)), nonce_counter: 0 }
    }

    fn nonce(&mut self) -> [u8; 32] {
        self.nonce_counter += 1;
        let mut n = [7u8; 32];
        n[..4].copy_from_slice(&self.nonce_counter.to_le_bytes());
        n
    }

    /// Signs `payload` for `action` as `owner` with `k`, for an explicit recipient.
    fn auth_full(&mut self, k: &SigningKey, action: &str, owner: &str, payload: &str, recipient: &str, attest: bool) -> SignedAuth {
        let nonce = self.nonce();
        let hash = test_nep413_hash(&test_message(action, owner, payload), &nonce, recipient);
        let sig = k.sign(&hash);
        assert!(k.verifying_key().verify(&hash, &sig).is_ok());
        SignedAuth {
            owner: acc(owner),
            public_key: pk(k),
            nonce: B64.encode(nonce),
            signature: B64.encode(sig.to_bytes()),
            attest_key: attest,
        }
    }

    fn auth(&mut self, k: &SigningKey, action: &str, owner: &str, payload: &str, attest: bool) -> SignedAuth {
        self.auth_full(k, action, owner, payload, CONTRACT, attest)
    }

    // Relayed writes (sets predecessor = relayer).

    fn put_invoice(&mut self, k: &SigningKey, owner: &str, payload: &str, attest: bool) {
        let a = self.auth(k, "put_invoice", owner, payload, attest);
        ctx(RELAYER);
        self.c.put_invoice(payload.to_string(), a);
    }

    fn cancel_invoice(&mut self, k: &SigningKey, owner: &str, public_id: &str) {
        let payload = json!({ "public_id": public_id }).to_string();
        let a = self.auth(k, "cancel_invoice", owner, &payload, false);
        ctx(RELAYER);
        self.c.cancel_invoice(payload, a);
    }

    fn put_bill(&mut self, k: &SigningKey, owner: &str, payload: &str) {
        let a = self.auth(k, "put_bill", owner, payload, true);
        ctx(RELAYER);
        self.c.put_bill(payload.to_string(), a);
    }

    fn cancel_bill(&mut self, k: &SigningKey, owner: &str, id: &str) {
        let payload = json!({ "id": id }).to_string();
        let a = self.auth(k, "cancel_bill", owner, &payload, true);
        ctx(RELAYER);
        self.c.cancel_bill(payload, a);
    }

    fn put_payee(&mut self, k: &SigningKey, owner: &str, id: &str, name: &str) {
        let payload = payee_payload(id, name);
        let a = self.auth(k, "put_payee", owner, &payload, true);
        ctx(RELAYER);
        self.c.put_payee(payload, a);
    }

    fn remove_payee(&mut self, k: &SigningKey, owner: &str, id: &str) {
        let payload = json!({ "id": id }).to_string();
        let a = self.auth(k, "remove_payee", owner, &payload, true);
        ctx(RELAYER);
        self.c.remove_payee(payload, a);
    }

    fn put_batch(&mut self, k: &SigningKey, owner: &str, payload: &str) {
        let a = self.auth(k, "put_batch", owner, payload, true);
        ctx(RELAYER);
        self.c.put_batch(payload.to_string(), a);
    }
}

fn invoice_payload(public_id: &str) -> String {
    json!({
        "public_id": public_id,
        "number": "INV-001",
        "issuer": "Example Studio",
        "client": "Client Co",
        "due_date": "2030-01-31",
        "token_id": "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
        "total": "700000",
        "notes": "Thanks",
        "items": [
            { "description": "Design", "quantity": "3", "unit_price": "0.1" },
            { "description": "Build", "quantity": "2", "unit_price": "0.2" }
        ],
        "created_at": "2026-11-01T10:00:00.000Z",
        "issued_at": "2026-11-01T10:05:00.000Z"
    })
    .to_string()
}

fn bill_payload(id: &str, amount: &str) -> String {
    json!({
        "id": id,
        "vendor": "Vendor Ltd",
        "reference": "REF-9",
        "due_date": "2030-02-01",
        "destination_asset": "nep141:wrap.near",
        "recipient_type": "INTENTS",
        "recipient": "vendor.near",
        "amount": amount,
        "source": "frenzypay",
        "vendor_public_id": "AbCdEfGhIjKlMnOp1234",
        "created_at": "2026-11-02T00:00:00Z"
    })
    .to_string()
}

fn payee_payload(id: &str, name: &str) -> String {
    json!({
        "id": id,
        "name": name,
        "destination_asset": "nep141:wrap.near",
        "recipient_type": "DESTINATION_CHAIN",
        "recipient": "0x000000000000000000000000000000000000dEaD",
        "created_at": "2026-11-02T00:00:00Z"
    })
    .to_string()
}

fn batch_payload(id: &str, lines: usize) -> String {
    let lines: Vec<Value> = (1..=lines)
        .map(|n| {
            json!({
                "n": n,
                "name": format!("Worker {n}"),
                "destination_asset": "nep141:wrap.near",
                "recipient_type": "INTENTS",
                "recipient": format!("worker{n}.near"),
                "amount": format!("{}", n * 1000)
            })
        })
        .collect();
    json!({
        "id": id,
        "title": "November payroll",
        "origin_asset": "nep141:usdc.near",
        "created_at": "2026-11-03T00:00:00Z",
        "lines": lines
    })
    .to_string()
}

fn panic_msg(e: Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = e.downcast_ref::<String>() {
        s.clone()
    } else if let Some(s) = e.downcast_ref::<&str>() {
        s.to_string()
    } else {
        "<non-string panic>".into()
    }
}

/// Runs `f` and asserts it panics with a message containing `code`.
fn expect_err<F: FnOnce()>(code: &str, f: F) {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(()) => panic!("expected panic {code}, but call succeeded"),
        Err(e) => {
            let msg = panic_msg(e);
            assert!(msg.contains(code), "expected {code}, got {msg}");
        }
    }
}

fn events() -> Vec<Value> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str::<Value>(j).unwrap())
        .collect()
}

fn event_names() -> Vec<String> {
    events().iter().map(|e| e["event"].as_str().unwrap().to_string()).collect()
}

const PID: &str = "pub_0123456789abcdef";

// ---------------------------------------------------------------- auth

#[test]
fn hash_helpers_agree_with_contract() {
    ctx(RELAYER);
    let payload = invoice_payload(PID);
    let ours = test_message("put_invoice", ALICE, &payload);
    let theirs = auth::record_message("put_invoice", &acc(ALICE), &payload);
    assert_eq!(ours, theirs);
    let nonce = [9u8; 32];
    assert_eq!(test_nep413_hash(&ours, &nonce, CONTRACT), auth::nep413_hash(&theirs, &nonce, CONTRACT).to_vec());
}

#[test]
fn non_relayer_write_rejected() {
    let mut fx = Fx::new();
    let k = key(1);
    let payload = invoice_payload(PID);
    let a = fx.auth(&k, "put_invoice", ALICE, &payload, true);
    ctx(ALICE);
    expect_err("ERR_NOT_RELAYER", || fx.c.put_invoice(payload.clone(), a.clone()));
    ctx(ADMIN);
    expect_err("ERR_NOT_RELAYER", || fx.c.put_invoice(payload, a));
}

#[test]
fn valid_signature_with_attest_registers_relayer_key() {
    let mut fx = Fx::new();
    let k = key(1);
    fx.put_invoice(&k, ALICE, &invoice_payload(PID), true);
    assert_eq!(event_names(), vec!["key_registered", "invoice_issued"]);
    let ev = events();
    assert_eq!(ev[0]["data"][0]["source"], "relayer");
    assert_eq!(ev[0]["data"][0]["owner"], ALICE);
    assert_eq!(ev[1]["data"][0]["public_id"], PID);
    assert_eq!(ev[1]["data"][0]["total"], "700000");

    let inv = fx.c.get_invoice(PID.into()).unwrap();
    assert_eq!(inv.owner, acc(ALICE));
    assert_eq!(inv.status, InvoiceStatus::Issued);
    assert_eq!(inv.total.0, 700_000);
    assert_eq!(inv.items.len(), 2);
    assert_eq!(inv.recorded_at_ms, T0_MS);

    let info = fx.c.get_key(acc(ALICE), pk(&k)).unwrap();
    assert_eq!(info.source, KeySource::Relayer);
    assert_eq!(info.registered_at_ms, T0_MS);
    // key is per owner
    assert!(fx.c.get_key(acc(BOB), pk(&k)).is_none());
}

#[test]
fn tampered_payload_rejected() {
    let mut fx = Fx::new();
    let k = key(1);
    let signed = invoice_payload(PID);
    let a = fx.auth(&k, "put_invoice", ALICE, &signed, true);
    let tampered = signed.replace("700000", "900000");
    ctx(RELAYER);
    expect_err("ERR_BAD_SIGNATURE", || fx.c.put_invoice(tampered, a));
    assert!(fx.c.get_invoice(PID.into()).is_none());
}

#[test]
fn wrong_key_rejected() {
    let mut fx = Fx::new();
    let payload = invoice_payload(PID);
    let mut a = fx.auth(&key(2), "put_invoice", ALICE, &payload, true);
    a.public_key = pk(&key(1)); // claims key 1, signed by key 2
    ctx(RELAYER);
    expect_err("ERR_BAD_SIGNATURE", || fx.c.put_invoice(payload, a));
}

#[test]
fn wrong_recipient_rejected() {
    let mut fx = Fx::new();
    let payload = invoice_payload(PID);
    let a = fx.auth_full(&key(1), "put_invoice", ALICE, &payload, "other.near", true);
    ctx(RELAYER);
    expect_err("ERR_BAD_SIGNATURE", || fx.c.put_invoice(payload, a));
}

#[test]
fn wrong_action_or_owner_rejected() {
    let mut fx = Fx::new();
    let payload = invoice_payload(PID);
    let a = fx.auth(&key(1), "cancel_invoice", ALICE, &payload, true);
    ctx(RELAYER);
    expect_err("ERR_BAD_SIGNATURE", || fx.c.put_invoice(payload.clone(), a));
    let mut a = fx.auth(&key(1), "put_invoice", ALICE, &payload, true);
    a.owner = acc(BOB);
    ctx(RELAYER);
    expect_err("ERR_BAD_SIGNATURE", || fx.c.put_invoice(payload, a));
}

#[test]
fn malformed_auth_rejected() {
    let mut fx = Fx::new();
    let payload = invoice_payload(PID);
    let good = fx.auth(&key(1), "put_invoice", ALICE, &payload, true);
    ctx(RELAYER);
    let mut a = good.clone();
    a.public_key = "secp256k1:abc".into();
    expect_err("ERR_BAD_PUBLIC_KEY", || fx.c.put_invoice(payload.clone(), a));
    let mut a = good.clone();
    a.nonce = B64.encode([1u8; 16]);
    expect_err("ERR_BAD_NONCE", || fx.c.put_invoice(payload.clone(), a));
    let mut a = good;
    a.signature = B64.encode([1u8; 63]);
    expect_err("ERR_BAD_SIGNATURE", || fx.c.put_invoice(payload, a));
}

#[test]
fn replayed_nonce_rejected() {
    let mut fx = Fx::new();
    let k = key(1);
    let payload = payee_payload("payee1", "Ann");
    let a = fx.auth(&k, "put_payee", ALICE, &payload, true);
    assert!(!fx.c.is_nonce_used(a.nonce.clone()));
    ctx(RELAYER);
    fx.c.put_payee(payload.clone(), a.clone());
    assert!(fx.c.is_nonce_used(a.nonce.clone()));
    ctx(RELAYER);
    expect_err("ERR_NONCE_USED", || fx.c.put_payee(payload, a));
}

#[test]
fn unregistered_key_rejected_without_attest() {
    let mut fx = Fx::new();
    let payload = invoice_payload(PID);
    expect_err("ERR_KEY_NOT_REGISTERED", || fx.put_invoice(&key(1), ALICE, &payload, false));
    assert!(fx.c.get_key(acc(ALICE), pk(&key(1))).is_none());
}

#[test]
fn self_registered_key_writes_without_attest() {
    let mut fx = Fx::new();
    let k = key(3);
    ctx(ALICE);
    fx.c.register_key(pk(&k));
    assert_eq!(event_names(), vec!["key_registered"]);
    assert_eq!(events()[0]["data"][0]["source"], "self");
    let info = fx.c.get_key(acc(ALICE), pk(&k)).unwrap();
    assert_eq!(info.source, KeySource::SelfRegistered);
    assert_eq!(serde_json::to_value(&info).unwrap(), json!({ "source": "self", "registered_at_ms": T0_MS }));

    fx.put_invoice(&k, ALICE, &invoice_payload(PID), false);
    assert_eq!(event_names(), vec!["invoice_issued"]);
    assert!(fx.c.get_invoice(PID.into()).is_some());

    // a key registered by alice does not authorize writes for bob
    expect_err("ERR_KEY_NOT_REGISTERED", || {
        fx.put_invoice(&k, BOB, &invoice_payload("pub_bbbbbbbbbbbbbbbb"), false)
    });
}

#[test]
fn self_registration_upgrades_attested_key() {
    let mut fx = Fx::new();
    let k = key(1);
    fx.put_invoice(&k, ALICE, &invoice_payload(PID), true);
    ctx(ALICE);
    fx.c.register_key(pk(&k));
    assert_eq!(fx.c.get_key(acc(ALICE), pk(&k)).unwrap().source, KeySource::SelfRegistered);
    // attest on an already-registered key keeps the self source
    fx.put_invoice(&k, ALICE, &invoice_payload("pub_cccccccccccccccc"), true);
    assert_eq!(event_names(), vec!["invoice_issued"]);
    assert_eq!(fx.c.get_key(acc(ALICE), pk(&k)).unwrap().source, KeySource::SelfRegistered);
}

#[test]
fn revoked_key_rejected_until_reattested() {
    let mut fx = Fx::new();
    let k = key(4);
    ctx(ALICE);
    fx.c.register_key(pk(&k));
    ctx(ALICE);
    fx.c.revoke_key(pk(&k));
    assert_eq!(event_names(), vec!["key_revoked"]);
    assert!(fx.c.get_key(acc(ALICE), pk(&k)).is_none());
    expect_err("ERR_KEY_NOT_REGISTERED", || fx.put_invoice(&k, ALICE, &invoice_payload(PID), false));
    // revoking an unknown key fails; bob cannot revoke alice's keys (it only touches bob's own)
    ctx(BOB);
    expect_err("ERR_KEY_NOT_REGISTERED", || fx.c.revoke_key(pk(&k)));
    // the relayer can attest the same key again (documented residual trust)
    fx.put_invoice(&k, ALICE, &invoice_payload("pub_dddddddddddddddd"), true);
    assert_eq!(fx.c.get_key(acc(ALICE), pk(&k)).unwrap().source, KeySource::Relayer);
}

#[test]
fn key_count_is_capped() {
    let mut fx = Fx::new();
    for i in 0..MAX_KEYS_PER_OWNER {
        ctx(ALICE);
        fx.c.register_key(pk(&key(10 + i as u8)));
    }
    ctx(ALICE);
    expect_err("ERR_TOO_MANY_KEYS", || fx.c.register_key(pk(&key(200))));
    // re-registering an existing key does not count again
    ctx(ALICE);
    fx.c.register_key(pk(&key(10)));
    ctx(ALICE);
    fx.c.revoke_key(pk(&key(10)));
    ctx(ALICE);
    fx.c.register_key(pk(&key(200)));
}

// ---------------------------------------------------------------- invoices

#[test]
fn invoice_create_only() {
    let mut fx = Fx::new();
    let k = key(1);
    fx.put_invoice(&k, ALICE, &invoice_payload(PID), true);
    expect_err("ERR_EXISTS", || fx.put_invoice(&k, ALICE, &invoice_payload(PID), false));
    expect_err("ERR_EXISTS", || fx.put_invoice(&key(2), BOB, &invoice_payload(PID), true));
}

#[test]
fn invoice_validation() {
    let mut fx = Fx::new();
    let k = key(1);
    let base: Value = serde_json::from_str(&invoice_payload(PID)).unwrap();
    let with = |field: &str, v: Value| {
        let mut p = base.clone();
        p[field] = v;
        p.to_string()
    };
    expect_err("ERR_BAD_ID", || fx.put_invoice(&k, ALICE, &with("public_id", json!("short")), true));
    expect_err("ERR_BAD_ID", || fx.put_invoice(&k, ALICE, &with("public_id", json!("bad id with spaces!!")), true));
    expect_err("ERR_BAD_DATE", || fx.put_invoice(&k, ALICE, &with("due_date", json!("2030-1-31")), true));
    expect_err("ERR_BAD_AMOUNT", || fx.put_invoice(&k, ALICE, &with("total", json!("0")), true));
    expect_err("ERR_BAD_PAYLOAD", || fx.put_invoice(&k, ALICE, &with("total", json!(5)), true));
    expect_err("ERR_TOO_LONG", || fx.put_invoice(&k, ALICE, &with("notes", json!("x".repeat(281))), true));
    expect_err("ERR_TOO_LONG", || fx.put_invoice(&k, ALICE, &with("client", json!("x".repeat(101))), true));
    let items: Vec<Value> = (0..11).map(|_| json!({ "description": "a", "quantity": "1", "unit_price": "1" })).collect();
    expect_err("ERR_BAD_ITEMS", || fx.put_invoice(&k, ALICE, &with("items", json!(items)), true));
    expect_err("ERR_BAD_PAYLOAD", || fx.put_invoice(&k, ALICE, &with("client_email", json!("a@b.c")), true));
    let big = with("notes", json!("x".repeat(17_000)));
    expect_err("ERR_PAYLOAD_TOO_LARGE", || fx.put_invoice(&k, ALICE, &big, true));
    // multibyte text is counted in characters
    fx.put_invoice(&k, ALICE, &with("notes", json!("é".repeat(280))), true);
}

#[test]
fn cancel_invoice_flow() {
    let mut fx = Fx::new();
    let (ka, kb) = (key(1), key(2));
    fx.put_invoice(&ka, ALICE, &invoice_payload(PID), true);
    // bob (with his own attested key) cannot cancel alice's invoice
    let payload = json!({ "public_id": PID }).to_string();
    let a = fx.auth(&kb, "cancel_invoice", BOB, &payload, true);
    ctx(RELAYER);
    expect_err("ERR_NOT_OWNER", || fx.c.cancel_invoice(payload, a));

    ctx_at(RELAYER, T0_MS + 5);
    let payload = json!({ "public_id": PID }).to_string();
    let a = fx.auth(&ka, "cancel_invoice", ALICE, &payload, false);
    ctx_at(RELAYER, T0_MS + 5);
    fx.c.cancel_invoice(payload, a);
    assert_eq!(event_names(), vec!["invoice_cancelled"]);
    let inv = fx.c.get_invoice(PID.into()).unwrap();
    assert_eq!(inv.status, InvoiceStatus::Cancelled);
    assert_eq!(inv.cancelled_at_ms, Some(T0_MS + 5));
    assert_eq!(inv.updated_at_ms, T0_MS + 5);

    expect_err("ERR_CANCELLED", || fx.cancel_invoice(&ka, ALICE, PID));
    ctx(RELAYER);
    expect_err("ERR_CANCELLED", || fx.c.mark_invoice_paid(PID.into(), "dep".into(), None));
    expect_err("ERR_NOT_FOUND", || fx.cancel_invoice(&ka, ALICE, "pub_nonexistent0000"));
}

#[test]
fn mark_invoice_paid_flow() {
    let mut fx = Fx::new();
    let k = key(1);
    fx.put_invoice(&k, ALICE, &invoice_payload(PID), true);

    ctx(ALICE);
    expect_err("ERR_NOT_RELAYER", || fx.c.mark_invoice_paid(PID.into(), "dep1".into(), None));
    ctx(ADMIN);
    expect_err("ERR_NOT_RELAYER", || fx.c.mark_invoice_paid(PID.into(), "dep1".into(), None));

    ctx_at(RELAYER, T0_MS + 9);
    fx.c.mark_invoice_paid(PID.into(), "dep1".into(), Some("txhash1".into()));
    let ev = events();
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["event"], "invoice_paid");
    assert_eq!(ev[0]["data"][0]["deposit_address"], "dep1");
    assert_eq!(ev[0]["data"][0]["tx_hash"], "txhash1");
    assert_eq!(ev[0]["data"][0]["owner"], ALICE);
    let inv = fx.c.get_invoice(PID.into()).unwrap();
    assert_eq!(inv.status, InvoiceStatus::Paid);
    assert_eq!(inv.paid_at_ms, Some(T0_MS + 9));
    assert_eq!(inv.paid_by.as_deref(), Some("dep1"));
    assert_eq!(inv.paid_tx_hash.as_deref(), Some("txhash1"));

    ctx(RELAYER);
    expect_err("ERR_ALREADY_PAID", || fx.c.mark_invoice_paid(PID.into(), "dep2".into(), None));
    expect_err("ERR_ALREADY_PAID", || fx.cancel_invoice(&k, ALICE, PID));
    ctx(RELAYER);
    expect_err("ERR_NOT_FOUND", || fx.c.mark_invoice_paid("pub_nonexistent0000".into(), "d".into(), None));
}

#[test]
fn invoice_view_json_shape() {
    let mut fx = Fx::new();
    fx.put_invoice(&key(1), ALICE, &invoice_payload(PID), true);
    let v = serde_json::to_value(fx.c.get_invoice(PID.into()).unwrap()).unwrap();
    assert_eq!(v["status"], "issued");
    assert_eq!(v["owner"], ALICE);
    assert_eq!(v["total"], "700000");
    assert_eq!(v["items"][0]["unit_price"], "0.1");
    assert_eq!(v["recorded_at_ms"], T0_MS);
    assert!(v["paid_at_ms"].is_null());
    assert!(v["paid_by"].is_null());
    assert!(v["cancelled_at_ms"].is_null());
}

// ---------------------------------------------------------------- bills

#[test]
fn bill_replace_cancel_and_pay() {
    let mut fx = Fx::new();
    let k = key(1);
    fx.put_bill(&k, ALICE, &bill_payload("bill-1", "100"));
    assert_eq!(event_names(), vec!["key_registered", "bill_saved"]);
    assert_eq!(events()[1]["data"][0]["replaced"], false);

    ctx_at(RELAYER, T0_MS + 1);
    let payload = bill_payload("bill-1", "250");
    let a = fx.auth(&k, "put_bill", ALICE, &payload, false);
    ctx_at(RELAYER, T0_MS + 1);
    fx.c.put_bill(payload, a);
    assert_eq!(events()[0]["data"][0]["replaced"], true);
    let b = fx.c.get_bill("bill-1".into()).unwrap();
    assert_eq!(b.amount.0, 250);
    assert_eq!(b.recorded_at_ms, T0_MS);
    assert_eq!(b.updated_at_ms, T0_MS + 1);
    assert_eq!(b.status, BillStatus::Scheduled);
    assert_eq!(b.recipient_type, RecipientType::Intents);
    assert_eq!(b.source, BillSource::Frenzypay);
    assert_eq!(fx.c.list_bills_by_owner(acc(ALICE), None, None).len(), 1);
    let v = serde_json::to_value(&b).unwrap();
    assert_eq!(v["recipient_type"], "INTENTS");
    assert_eq!(v["source"], "frenzypay");
    assert_eq!(v["status"], "scheduled");

    // another owner cannot overwrite
    expect_err("ERR_NOT_OWNER", || fx.put_bill(&key(2), BOB, &bill_payload("bill-1", "1")));

    // pay, then replacement and cancel are refused
    ctx(BOB);
    expect_err("ERR_NOT_RELAYER", || fx.c.mark_bill_paid("bill-1".into(), "dep".into(), None));
    ctx(RELAYER);
    fx.c.mark_bill_paid("bill-1".into(), "dep".into(), Some("tx".into()));
    assert_eq!(event_names(), vec!["bill_paid"]);
    assert_eq!(events()[0]["data"][0]["amount"], "250");
    let b = fx.c.get_bill("bill-1".into()).unwrap();
    assert_eq!(b.status, BillStatus::Paid);
    assert_eq!(b.paid_by.as_deref(), Some("dep"));
    ctx(RELAYER);
    expect_err("ERR_ALREADY_PAID", || fx.c.mark_bill_paid("bill-1".into(), "dep".into(), None));
    expect_err("ERR_ALREADY_PAID", || fx.put_bill(&k, ALICE, &bill_payload("bill-1", "300")));
    expect_err("ERR_ALREADY_PAID", || fx.cancel_bill(&k, ALICE, "bill-1"));

    // cancel flow on a second bill
    fx.put_bill(&k, ALICE, &bill_payload("bill-2", "5"));
    expect_err("ERR_NOT_OWNER", || fx.cancel_bill(&key(2), BOB, "bill-2"));
    fx.cancel_bill(&k, ALICE, "bill-2");
    assert_eq!(event_names(), vec!["bill_cancelled"]);
    assert_eq!(fx.c.get_bill("bill-2".into()).unwrap().status, BillStatus::Cancelled);
    expect_err("ERR_CANCELLED", || fx.cancel_bill(&k, ALICE, "bill-2"));
    expect_err("ERR_CANCELLED", || fx.put_bill(&k, ALICE, &bill_payload("bill-2", "6")));
    ctx(RELAYER);
    expect_err("ERR_CANCELLED", || fx.c.mark_bill_paid("bill-2".into(), "dep".into(), None));
}

#[test]
fn bill_enum_and_optional_fields() {
    let mut fx = Fx::new();
    let k = key(1);
    let mut p: Value = serde_json::from_str(&bill_payload("bill-x", "1")).unwrap();
    p["recipient_type"] = json!("SOMETHING");
    expect_err("ERR_BAD_PAYLOAD", || fx.put_bill(&k, ALICE, &p.to_string()));
    let mut p: Value = serde_json::from_str(&bill_payload("bill-x", "1")).unwrap();
    p["source"] = json!("other");
    expect_err("ERR_BAD_PAYLOAD", || fx.put_bill(&k, ALICE, &p.to_string()));
    // vendor_public_id may be null or absent
    let mut p: Value = serde_json::from_str(&bill_payload("bill-x", "1")).unwrap();
    p["vendor_public_id"] = Value::Null;
    p["source"] = json!("manual");
    p["recipient_type"] = json!("DESTINATION_CHAIN");
    fx.put_bill(&k, ALICE, &p.to_string());
    p.as_object_mut().unwrap().remove("vendor_public_id");
    p["id"] = json!("bill-y");
    fx.put_bill(&k, ALICE, &p.to_string());
    assert!(fx.c.get_bill("bill-y".into()).unwrap().vendor_public_id.is_none());
}

// ---------------------------------------------------------------- payees + pagination

#[test]
fn payee_save_replace_remove() {
    let mut fx = Fx::new();
    let k = key(1);
    fx.put_payee(&k, ALICE, "p1", "Ann");
    fx.put_payee(&k, ALICE, "p2", "Ben");
    fx.put_payee(&k, ALICE, "p3", "Cid");
    fx.put_payee(&k, ALICE, "p2", "Ben Two");
    assert_eq!(event_names(), vec!["payee_saved"]);
    expect_err("ERR_NOT_OWNER", || fx.put_payee(&key(2), BOB, "p2", "Mallory"));
    let names: Vec<String> = fx.c.list_payees_by_owner(acc(ALICE), None, None).into_iter().map(|p| p.name).collect();
    assert_eq!(names, vec!["Ann", "Ben Two", "Cid"]);

    expect_err("ERR_NOT_OWNER", || fx.remove_payee(&key(2), BOB, "p1"));
    fx.remove_payee(&k, ALICE, "p1");
    assert_eq!(event_names(), vec!["payee_removed"]);
    assert!(fx.c.get_payee("p1".into()).is_none());
    let ids: Vec<String> = fx.c.list_payees_by_owner(acc(ALICE), None, None).into_iter().map(|p| p.id).collect();
    assert_eq!(ids, vec!["p2", "p3"]);
    expect_err("ERR_NOT_FOUND", || fx.remove_payee(&k, ALICE, "p1"));
    // re-adding appends at the end
    fx.put_payee(&k, ALICE, "p1", "Ann again");
    let ids: Vec<String> = fx.c.list_payees_by_owner(acc(ALICE), None, None).into_iter().map(|p| p.id).collect();
    assert_eq!(ids, vec!["p2", "p3", "p1"]);
}

#[test]
fn pagination_defaults_and_cap() {
    let mut fx = Fx::new();
    let k = key(1);
    for i in 0..120 {
        fx.put_payee(&k, ALICE, &format!("p{i:03}"), "Name");
    }
    let c = &fx.c;
    let ids = |v: Vec<Payee>| v.into_iter().map(|p| p.id).collect::<Vec<_>>();
    let first = ids(c.list_payees_by_owner(acc(ALICE), None, None));
    assert_eq!(first.len(), 50);
    assert_eq!(first[0], "p000");
    assert_eq!(first[49], "p049");
    let capped = ids(c.list_payees_by_owner(acc(ALICE), None, Some(1000)));
    assert_eq!(capped.len(), 100);
    let tail = ids(c.list_payees_by_owner(acc(ALICE), Some(100), Some(100)));
    assert_eq!(tail.len(), 20);
    assert_eq!(tail[0], "p100");
    assert_eq!(tail[19], "p119");
    let mid = ids(c.list_payees_by_owner(acc(ALICE), Some(10), Some(3)));
    assert_eq!(mid, vec!["p010", "p011", "p012"]);
    assert!(c.list_payees_by_owner(acc(ALICE), Some(500), None).is_empty());
    assert!(c.list_payees_by_owner(acc(ALICE), Some(u32::MAX), Some(100)).is_empty());
    assert!(c.list_payees_by_owner(acc(ALICE), None, Some(0)).is_empty());
    assert!(c.list_payees_by_owner(acc(BOB), None, None).is_empty());
    assert!(c.list_invoices_by_owner(acc(ALICE), None, None).is_empty());
}

#[test]
fn listing_is_per_owner() {
    let mut fx = Fx::new();
    fx.put_invoice(&key(1), ALICE, &invoice_payload("pub_aaaaaaaaaaaaaaa1"), true);
    fx.put_invoice(&key(2), BOB, &invoice_payload("pub_bbbbbbbbbbbbbbb1"), true);
    fx.put_invoice(&key(1), ALICE, &invoice_payload("pub_aaaaaaaaaaaaaaa2"), false);
    let ids: Vec<String> =
        fx.c.list_invoices_by_owner(acc(ALICE), None, None).into_iter().map(|i| i.public_id).collect();
    assert_eq!(ids, vec!["pub_aaaaaaaaaaaaaaa1", "pub_aaaaaaaaaaaaaaa2"]);
    assert_eq!(fx.c.list_invoices_by_owner(acc(BOB), None, None).len(), 1);
}

// ---------------------------------------------------------------- payroll

#[test]
fn batch_create_and_line_paid() {
    let mut fx = Fx::new();
    let k = key(1);
    fx.put_batch(&k, ALICE, &batch_payload("batch-1", 3));
    assert_eq!(event_names(), vec!["key_registered", "payroll_batch_created"]);
    let ev = &events()[1]["data"][0];
    assert_eq!(ev["lines"], 3);
    assert_eq!(ev["total"], "6000");
    expect_err("ERR_EXISTS", || fx.put_batch(&k, ALICE, &batch_payload("batch-1", 2)));

    ctx(ALICE);
    expect_err("ERR_NOT_RELAYER", || fx.c.mark_payroll_line_paid("batch-1".into(), 2, "dep".into(), None));
    ctx_at(RELAYER, T0_MS + 3);
    fx.c.mark_payroll_line_paid("batch-1".into(), 2, "dep2".into(), Some("tx2".into()));
    let ev = events();
    assert_eq!(ev[0]["event"], "payroll_line_paid");
    assert_eq!(ev[0]["data"][0]["batch_id"], "batch-1");
    assert_eq!(ev[0]["data"][0]["n"], 2);
    assert_eq!(ev[0]["data"][0]["amount"], "2000");
    let b = fx.c.get_batch("batch-1".into()).unwrap();
    assert_eq!(b.lines[1].paid_at_ms, Some(T0_MS + 3));
    assert_eq!(b.lines[1].paid_by.as_deref(), Some("dep2"));
    assert_eq!(b.lines[1].paid_tx_hash.as_deref(), Some("tx2"));
    assert!(b.lines[0].paid_at_ms.is_none());
    assert_eq!(b.updated_at_ms, T0_MS + 3);

    ctx(RELAYER);
    expect_err("ERR_ALREADY_PAID", || fx.c.mark_payroll_line_paid("batch-1".into(), 2, "dep".into(), None));
    expect_err("ERR_LINE_NOT_FOUND", || fx.c.mark_payroll_line_paid("batch-1".into(), 4, "dep".into(), None));
    expect_err("ERR_NOT_FOUND", || fx.c.mark_payroll_line_paid("nope".into(), 1, "dep".into(), None));
    assert_eq!(fx.c.list_batches_by_owner(acc(ALICE), None, None).len(), 1);
}

#[test]
fn batch_validation() {
    let mut fx = Fx::new();
    let k = key(1);
    expect_err("ERR_BAD_LINES", || fx.put_batch(&k, ALICE, &batch_payload("b0", 0)));
    expect_err("ERR_BAD_LINES", || fx.put_batch(&k, ALICE, &batch_payload("b51", 51)));
    fx.put_batch(&k, ALICE, &batch_payload("b50", 50));
    let mut p: Value = serde_json::from_str(&batch_payload("bx", 2)).unwrap();
    p["lines"][1]["n"] = json!(3);
    expect_err("ERR_BAD_LINE_NUMBER", || fx.put_batch(&k, ALICE, &p.to_string()));
    let mut p: Value = serde_json::from_str(&batch_payload("bx", 2)).unwrap();
    p["lines"][0]["paid_by"] = json!("x");
    expect_err("ERR_BAD_PAYLOAD", || fx.put_batch(&k, ALICE, &p.to_string()));
}

// ---------------------------------------------------------------- admin

#[test]
fn owner_only_admin() {
    let mut fx = Fx::new();
    ctx(RELAYER);
    expect_err("ERR_NOT_OWNER", || fx.c.set_relayer(acc(BOB)));
    ctx(ALICE);
    expect_err("ERR_NOT_OWNER", || fx.c.set_owner(acc(ALICE)));

    ctx(ADMIN);
    fx.c.set_relayer(acc("relayer2.near"));
    let ev = events();
    assert_eq!(ev[0]["event"], "relayer_changed");
    assert_eq!(ev[0]["data"][0]["old_relayer_id"], RELAYER);
    assert_eq!(ev[0]["data"][0]["new_relayer_id"], "relayer2.near");
    assert_eq!(fx.c.get_config().relayer_id, acc("relayer2.near"));

    // old relayer is now refused
    ctx(RELAYER);
    expect_err("ERR_NOT_RELAYER", || fx.c.mark_invoice_paid(PID.into(), "d".into(), None));

    ctx(ADMIN);
    fx.c.set_owner(acc(BOB));
    assert_eq!(event_names(), vec!["owner_changed"]);
    assert_eq!(serde_json::to_value(fx.c.get_config()).unwrap(), json!({ "owner_id": BOB, "relayer_id": "relayer2.near" }));
    ctx(ADMIN);
    expect_err("ERR_NOT_OWNER", || fx.c.set_relayer(acc(ADMIN)));
}

#[test]
fn event_log_format() {
    let mut fx = Fx::new();
    fx.put_invoice(&key(1), ALICE, &invoice_payload(PID), true);
    let logs = get_logs();
    assert_eq!(logs.len(), 2);
    assert!(logs[1].starts_with(r#"EVENT_JSON:{"standard":"frenzypay","version":"1.0.0","event":"invoice_issued","data":[{"#));
    let parsed: Value = serde_json::from_str(logs[1].strip_prefix("EVENT_JSON:").unwrap()).unwrap();
    assert!(parsed["data"].is_array());
}
