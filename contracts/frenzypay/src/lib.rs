//! FrenzyPay public records contract.
//!
//! Permanent, public records of invoices, bills, payees and payroll batches. Every record write
//! is relayed by a single whitelisted relayer account and carries an owner signature over the
//! exact payload (see [`auth`]). Payment confirmations (`mark_*`) are relayer-only.

pub mod auth;
pub mod events;
pub mod types;
pub mod validate;

#[cfg(test)]
mod tests;

use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::json_types::U128;
use near_sdk::serde::de::DeserializeOwned;
use near_sdk::serde_json::json;
use near_sdk::store::{LookupMap, LookupSet, Vector};
use near_sdk::{env, near, AccountId, BorshStorageKey, PanicOnDefault};

pub use auth::SignedAuth;
use auth::{decode_nonce, decode_signature, ed25519_key_string, nep413_hash, parse_ed25519_key, record_message};
use events::emit;
pub use types::*;

/// Upper bound on registered keys per owner; caps how much contract-paid storage one account can
/// consume through the permissionless `register_key`.
pub const MAX_KEYS_PER_OWNER: u32 = 20;
pub const DEFAULT_PAGE: u32 = 50;
pub const MAX_PAGE: u32 = 100;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Keys,
    KeyCounts,
    Nonces,
    Invoices,
    Bills,
    Payees,
    Batches,
    OwnerInvoices,
    OwnerBills,
    OwnerPayees,
    OwnerBatches,
    OwnerInvoiceList { owner_hash: [u8; 32] },
    OwnerBillList { owner_hash: [u8; 32] },
    OwnerPayeeList { owner_hash: [u8; 32] },
    OwnerBatchList { owner_hash: [u8; 32] },
}

type OwnerIndex = LookupMap<AccountId, Vector<String>>;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct FrenzyPay {
    owner_id: AccountId,
    relayer_id: AccountId,
    /// (owner, raw ed25519 key) -> registration info
    keys: LookupMap<(AccountId, [u8; 32]), KeyInfo>,
    key_counts: LookupMap<AccountId, u32>,
    nonces: LookupSet<[u8; 32]>,
    invoices: LookupMap<String, Invoice>,
    bills: LookupMap<String, Bill>,
    payees: LookupMap<String, Payee>,
    batches: LookupMap<String, PayrollBatch>,
    owner_invoices: OwnerIndex,
    owner_bills: OwnerIndex,
    owner_payees: OwnerIndex,
    owner_batches: OwnerIndex,
}

fn now_ms() -> u64 {
    env::block_timestamp_ms()
}

fn parse_payload<T: DeserializeOwned>(payload: &str) -> T {
    near_sdk::serde_json::from_str(payload)
        .unwrap_or_else(|e| env::panic_str(&format!("ERR_BAD_PAYLOAD: {e}")))
}

fn index_push(index: &mut OwnerIndex, owner: &AccountId, id: &str, prefix: fn([u8; 32]) -> StorageKey) {
    index
        .entry(owner.clone())
        .or_insert_with(|| Vector::new(prefix(env::sha256_array(owner.as_bytes()))))
        .push(id.to_string());
}

/// Removes `id` while keeping the remaining ids in insertion order.
fn index_remove(index: &mut OwnerIndex, owner: &AccountId, id: &str) {
    let Some(list) = index.get_mut(owner) else { return };
    let Some(pos) = list.iter().position(|x| x == id) else { return };
    let pos = pos as u32;
    for i in pos..list.len() - 1 {
        let next = list[i + 1].clone();
        list.set(i, next);
    }
    list.pop();
}

fn page<T>(
    index: &OwnerIndex,
    records: &LookupMap<String, T>,
    owner: &AccountId,
    from_index: Option<u32>,
    limit: Option<u32>,
) -> Vec<T>
where
    T: BorshSerialize + BorshDeserialize + Clone,
{
    let Some(list) = index.get(owner) else { return Vec::new() };
    let from = from_index.unwrap_or(0);
    let limit = limit.unwrap_or(DEFAULT_PAGE).min(MAX_PAGE);
    let end = from.saturating_add(limit).min(list.len());
    (from..end).filter_map(|i| list.get(i).and_then(|id| records.get(id)).cloned()).collect()
}

fn validate_tx(deposit_address: &str, tx_hash: &Option<String>) {
    validate::required_text("deposit_address", deposit_address);
    if let Some(tx) = tx_hash {
        validate::required_text("tx_hash", tx);
    }
}

#[near]
impl FrenzyPay {
    #[init]
    pub fn new(owner_id: AccountId, relayer_id: AccountId) -> Self {
        Self {
            owner_id,
            relayer_id,
            keys: LookupMap::new(StorageKey::Keys),
            key_counts: LookupMap::new(StorageKey::KeyCounts),
            nonces: LookupSet::new(StorageKey::Nonces),
            invoices: LookupMap::new(StorageKey::Invoices),
            bills: LookupMap::new(StorageKey::Bills),
            payees: LookupMap::new(StorageKey::Payees),
            batches: LookupMap::new(StorageKey::Batches),
            owner_invoices: LookupMap::new(StorageKey::OwnerInvoices),
            owner_bills: LookupMap::new(StorageKey::OwnerBills),
            owner_payees: LookupMap::new(StorageKey::OwnerPayees),
            owner_batches: LookupMap::new(StorageKey::OwnerBatches),
        }
    }

    // ---------------------------------------------------------------- admin

    pub fn set_relayer(&mut self, relayer_id: AccountId) {
        self.ensure_contract_owner();
        let old = std::mem::replace(&mut self.relayer_id, relayer_id);
        emit(
            "relayer_changed",
            json!({ "owner_id": self.owner_id, "old_relayer_id": old, "new_relayer_id": self.relayer_id }),
        );
    }

    pub fn set_owner(&mut self, owner_id: AccountId) {
        self.ensure_contract_owner();
        let old = std::mem::replace(&mut self.owner_id, owner_id);
        emit("owner_changed", json!({ "old_owner_id": old, "new_owner_id": self.owner_id }));
    }

    // ---------------------------------------------------------------- keys

    /// Registers `public_key` for the calling account (trustless: the caller is the owner).
    pub fn register_key(&mut self, public_key: String) {
        let owner = env::predecessor_account_id();
        let key = parse_ed25519_key(&public_key);
        self.store_key(owner, key, KeySource::SelfRegistered);
    }

    /// Removes `public_key` from the calling account's registered keys.
    pub fn revoke_key(&mut self, public_key: String) {
        let owner = env::predecessor_account_id();
        let key = parse_ed25519_key(&public_key);
        if self.keys.remove(&(owner.clone(), key)).is_none() {
            env::panic_str("ERR_KEY_NOT_REGISTERED");
        }
        let count = self.key_counts.get(&owner).copied().unwrap_or(1);
        if count <= 1 {
            self.key_counts.remove(&owner);
        } else {
            self.key_counts.insert(owner.clone(), count - 1);
        }
        emit("key_revoked", json!({ "owner": owner, "public_key": ed25519_key_string(&key) }));
    }

    // ---------------------------------------------------------------- invoices

    pub fn put_invoice(&mut self, payload: String, auth: SignedAuth) {
        self.authorize("put_invoice", &payload, &auth);
        let input: InvoiceInput = parse_payload(&payload);
        validate::public_id("public_id", &input.public_id);
        validate::name("number", &input.number);
        validate::name("issuer", &input.issuer);
        validate::name("client", &input.client);
        validate::date("due_date", &input.due_date);
        validate::required_text("token_id", &input.token_id);
        validate::amount("total", input.total);
        validate::text("notes", &input.notes);
        if input.items.is_empty() || input.items.len() > validate::MAX_INVOICE_ITEMS {
            env::panic_str("ERR_BAD_ITEMS: 1 to 10 items");
        }
        for item in &input.items {
            validate::required_text("items.description", &item.description);
            validate::name("items.quantity", &item.quantity);
            validate::name("items.unit_price", &item.unit_price);
        }
        validate::name("created_at", &input.created_at);
        validate::name("issued_at", &input.issued_at);
        if self.invoices.contains_key(&input.public_id) {
            env::panic_str("ERR_EXISTS");
        }

        let now = now_ms();
        let owner = auth.owner;
        let invoice = Invoice {
            public_id: input.public_id,
            owner: owner.clone(),
            number: input.number,
            issuer: input.issuer,
            client: input.client,
            due_date: input.due_date,
            token_id: input.token_id,
            total: input.total,
            notes: input.notes,
            items: input
                .items
                .into_iter()
                .map(|i| InvoiceItem { description: i.description, quantity: i.quantity, unit_price: i.unit_price })
                .collect(),
            created_at: input.created_at,
            issued_at: input.issued_at,
            status: InvoiceStatus::Issued,
            recorded_at_ms: now,
            updated_at_ms: now,
            cancelled_at_ms: None,
            paid_at_ms: None,
            paid_by: None,
            paid_tx_hash: None,
        };
        emit(
            "invoice_issued",
            json!({
                "owner": owner,
                "public_id": invoice.public_id,
                "number": invoice.number,
                "token_id": invoice.token_id,
                "total": invoice.total,
                "due_date": invoice.due_date,
            }),
        );
        index_push(&mut self.owner_invoices, &owner, &invoice.public_id, |owner_hash| {
            StorageKey::OwnerInvoiceList { owner_hash }
        });
        self.invoices.insert(invoice.public_id.clone(), invoice);
    }

    pub fn cancel_invoice(&mut self, payload: String, auth: SignedAuth) {
        self.authorize("cancel_invoice", &payload, &auth);
        let input: PublicIdInput = parse_payload(&payload);
        let invoice = self.invoices.get_mut(&input.public_id).unwrap_or_else(|| env::panic_str("ERR_NOT_FOUND"));
        if invoice.owner != auth.owner {
            env::panic_str("ERR_NOT_OWNER");
        }
        match invoice.status {
            InvoiceStatus::Issued => {}
            InvoiceStatus::Cancelled => env::panic_str("ERR_CANCELLED"),
            InvoiceStatus::Paid => env::panic_str("ERR_ALREADY_PAID"),
        }
        let now = now_ms();
        invoice.status = InvoiceStatus::Cancelled;
        invoice.cancelled_at_ms = Some(now);
        invoice.updated_at_ms = now;
        emit("invoice_cancelled", json!({ "owner": invoice.owner, "public_id": invoice.public_id }));
    }

    pub fn mark_invoice_paid(&mut self, public_id: String, deposit_address: String, tx_hash: Option<String>) {
        self.ensure_relayer();
        validate_tx(&deposit_address, &tx_hash);
        let invoice = self.invoices.get_mut(&public_id).unwrap_or_else(|| env::panic_str("ERR_NOT_FOUND"));
        match invoice.status {
            InvoiceStatus::Issued => {}
            InvoiceStatus::Cancelled => env::panic_str("ERR_CANCELLED"),
            InvoiceStatus::Paid => env::panic_str("ERR_ALREADY_PAID"),
        }
        let now = now_ms();
        invoice.status = InvoiceStatus::Paid;
        invoice.paid_at_ms = Some(now);
        invoice.paid_by = Some(deposit_address);
        invoice.paid_tx_hash = tx_hash;
        invoice.updated_at_ms = now;
        emit(
            "invoice_paid",
            json!({
                "owner": invoice.owner,
                "public_id": invoice.public_id,
                "token_id": invoice.token_id,
                "total": invoice.total,
                "deposit_address": invoice.paid_by,
                "tx_hash": invoice.paid_tx_hash,
            }),
        );
    }

    // ---------------------------------------------------------------- bills

    pub fn put_bill(&mut self, payload: String, auth: SignedAuth) {
        self.authorize("put_bill", &payload, &auth);
        let input: BillInput = parse_payload(&payload);
        validate::id("id", &input.id);
        validate::name("vendor", &input.vendor);
        validate::text("reference", &input.reference);
        validate::date("due_date", &input.due_date);
        validate::required_text("destination_asset", &input.destination_asset);
        validate::required_text("recipient", &input.recipient);
        validate::amount("amount", input.amount);
        if let Some(v) = &input.vendor_public_id {
            validate::public_id("vendor_public_id", v);
        }
        validate::name("created_at", &input.created_at);

        let now = now_ms();
        let owner = auth.owner;
        let existing = self.bills.get(&input.id);
        let (recorded_at_ms, replaced) = match existing {
            None => (now, false),
            Some(bill) => {
                if bill.owner != owner {
                    env::panic_str("ERR_NOT_OWNER");
                }
                match bill.status {
                    BillStatus::Scheduled => {}
                    BillStatus::Cancelled => env::panic_str("ERR_CANCELLED"),
                    BillStatus::Paid => env::panic_str("ERR_ALREADY_PAID"),
                }
                (bill.recorded_at_ms, true)
            }
        };
        let bill = Bill {
            id: input.id,
            owner: owner.clone(),
            vendor: input.vendor,
            reference: input.reference,
            due_date: input.due_date,
            destination_asset: input.destination_asset,
            recipient_type: input.recipient_type,
            recipient: input.recipient,
            amount: input.amount,
            source: input.source,
            vendor_public_id: input.vendor_public_id,
            created_at: input.created_at,
            status: BillStatus::Scheduled,
            recorded_at_ms,
            updated_at_ms: now,
            cancelled_at_ms: None,
            paid_at_ms: None,
            paid_by: None,
            paid_tx_hash: None,
        };
        emit(
            "bill_saved",
            json!({
                "owner": owner,
                "id": bill.id,
                "destination_asset": bill.destination_asset,
                "amount": bill.amount,
                "due_date": bill.due_date,
                "replaced": replaced,
            }),
        );
        if !replaced {
            index_push(&mut self.owner_bills, &owner, &bill.id, |owner_hash| StorageKey::OwnerBillList { owner_hash });
        }
        self.bills.insert(bill.id.clone(), bill);
    }

    pub fn cancel_bill(&mut self, payload: String, auth: SignedAuth) {
        self.authorize("cancel_bill", &payload, &auth);
        let input: IdInput = parse_payload(&payload);
        let bill = self.bills.get_mut(&input.id).unwrap_or_else(|| env::panic_str("ERR_NOT_FOUND"));
        if bill.owner != auth.owner {
            env::panic_str("ERR_NOT_OWNER");
        }
        match bill.status {
            BillStatus::Scheduled => {}
            BillStatus::Cancelled => env::panic_str("ERR_CANCELLED"),
            BillStatus::Paid => env::panic_str("ERR_ALREADY_PAID"),
        }
        let now = now_ms();
        bill.status = BillStatus::Cancelled;
        bill.cancelled_at_ms = Some(now);
        bill.updated_at_ms = now;
        emit("bill_cancelled", json!({ "owner": bill.owner, "id": bill.id }));
    }

    pub fn mark_bill_paid(&mut self, id: String, deposit_address: String, tx_hash: Option<String>) {
        self.ensure_relayer();
        validate_tx(&deposit_address, &tx_hash);
        let bill = self.bills.get_mut(&id).unwrap_or_else(|| env::panic_str("ERR_NOT_FOUND"));
        match bill.status {
            BillStatus::Scheduled => {}
            BillStatus::Cancelled => env::panic_str("ERR_CANCELLED"),
            BillStatus::Paid => env::panic_str("ERR_ALREADY_PAID"),
        }
        let now = now_ms();
        bill.status = BillStatus::Paid;
        bill.paid_at_ms = Some(now);
        bill.paid_by = Some(deposit_address);
        bill.paid_tx_hash = tx_hash;
        bill.updated_at_ms = now;
        emit(
            "bill_paid",
            json!({
                "owner": bill.owner,
                "id": bill.id,
                "destination_asset": bill.destination_asset,
                "amount": bill.amount,
                "deposit_address": bill.paid_by,
                "tx_hash": bill.paid_tx_hash,
            }),
        );
    }

    // ---------------------------------------------------------------- payees

    pub fn put_payee(&mut self, payload: String, auth: SignedAuth) {
        self.authorize("put_payee", &payload, &auth);
        let input: PayeeInput = parse_payload(&payload);
        validate::id("id", &input.id);
        validate::name("name", &input.name);
        validate::required_text("destination_asset", &input.destination_asset);
        validate::required_text("recipient", &input.recipient);
        validate::name("created_at", &input.created_at);

        let now = now_ms();
        let owner = auth.owner;
        let (recorded_at_ms, replaced) = match self.payees.get(&input.id) {
            None => (now, false),
            Some(p) if p.owner == owner => (p.recorded_at_ms, true),
            Some(_) => env::panic_str("ERR_NOT_OWNER"),
        };
        let payee = Payee {
            id: input.id,
            owner: owner.clone(),
            name: input.name,
            destination_asset: input.destination_asset,
            recipient_type: input.recipient_type,
            recipient: input.recipient,
            created_at: input.created_at,
            recorded_at_ms,
            updated_at_ms: now,
        };
        emit("payee_saved", json!({ "owner": owner, "id": payee.id, "replaced": replaced }));
        if !replaced {
            index_push(&mut self.owner_payees, &owner, &payee.id, |owner_hash| StorageKey::OwnerPayeeList { owner_hash });
        }
        self.payees.insert(payee.id.clone(), payee);
    }

    pub fn remove_payee(&mut self, payload: String, auth: SignedAuth) {
        self.authorize("remove_payee", &payload, &auth);
        let input: IdInput = parse_payload(&payload);
        let payee = self.payees.get(&input.id).unwrap_or_else(|| env::panic_str("ERR_NOT_FOUND"));
        if payee.owner != auth.owner {
            env::panic_str("ERR_NOT_OWNER");
        }
        self.payees.remove(&input.id);
        index_remove(&mut self.owner_payees, &auth.owner, &input.id);
        emit("payee_removed", json!({ "owner": auth.owner, "id": input.id }));
    }

    // ---------------------------------------------------------------- payroll

    pub fn put_batch(&mut self, payload: String, auth: SignedAuth) {
        self.authorize("put_batch", &payload, &auth);
        let input: BatchInput = parse_payload(&payload);
        validate::id("id", &input.id);
        validate::name("title", &input.title);
        validate::required_text("origin_asset", &input.origin_asset);
        validate::name("created_at", &input.created_at);
        if input.lines.is_empty() || input.lines.len() > validate::MAX_PAYROLL_LINES {
            env::panic_str("ERR_BAD_LINES: 1 to 50 lines");
        }
        let mut total: u128 = 0;
        for (i, line) in input.lines.iter().enumerate() {
            if line.n as usize != i + 1 {
                env::panic_str("ERR_BAD_LINE_NUMBER");
            }
            validate::name("lines.name", &line.name);
            validate::required_text("lines.destination_asset", &line.destination_asset);
            validate::required_text("lines.recipient", &line.recipient);
            validate::amount("lines.amount", line.amount);
            total = total.checked_add(line.amount.0).unwrap_or_else(|| env::panic_str("ERR_BAD_AMOUNT: total overflow"));
        }
        if self.batches.contains_key(&input.id) {
            env::panic_str("ERR_EXISTS");
        }

        let now = now_ms();
        let owner = auth.owner;
        let batch = PayrollBatch {
            id: input.id,
            owner: owner.clone(),
            title: input.title,
            origin_asset: input.origin_asset,
            created_at: input.created_at,
            lines: input
                .lines
                .into_iter()
                .map(|l| PayrollLine {
                    n: l.n,
                    name: l.name,
                    destination_asset: l.destination_asset,
                    recipient_type: l.recipient_type,
                    recipient: l.recipient,
                    amount: l.amount,
                    paid_at_ms: None,
                    paid_by: None,
                    paid_tx_hash: None,
                })
                .collect(),
            recorded_at_ms: now,
            updated_at_ms: now,
        };
        emit(
            "payroll_batch_created",
            json!({
                "owner": owner,
                "id": batch.id,
                "origin_asset": batch.origin_asset,
                "lines": batch.lines.len(),
                "total": U128(total),
            }),
        );
        index_push(&mut self.owner_batches, &owner, &batch.id, |owner_hash| StorageKey::OwnerBatchList { owner_hash });
        self.batches.insert(batch.id.clone(), batch);
    }

    pub fn mark_payroll_line_paid(&mut self, batch_id: String, n: u32, deposit_address: String, tx_hash: Option<String>) {
        self.ensure_relayer();
        validate_tx(&deposit_address, &tx_hash);
        let batch = self.batches.get_mut(&batch_id).unwrap_or_else(|| env::panic_str("ERR_NOT_FOUND"));
        let now = now_ms();
        let line = batch
            .lines
            .iter_mut()
            .find(|l| l.n == n)
            .unwrap_or_else(|| env::panic_str("ERR_LINE_NOT_FOUND"));
        if line.paid_at_ms.is_some() {
            env::panic_str("ERR_ALREADY_PAID");
        }
        line.paid_at_ms = Some(now);
        line.paid_by = Some(deposit_address);
        line.paid_tx_hash = tx_hash;
        let event = json!({
            "owner": batch.owner,
            "batch_id": batch.id,
            "n": n,
            "destination_asset": line.destination_asset,
            "amount": line.amount,
            "deposit_address": line.paid_by,
            "tx_hash": line.paid_tx_hash,
        });
        batch.updated_at_ms = now;
        emit("payroll_line_paid", event);
    }

    // ---------------------------------------------------------------- views

    pub fn get_config(&self) -> Config {
        Config { owner_id: self.owner_id.clone(), relayer_id: self.relayer_id.clone() }
    }

    pub fn get_invoice(&self, public_id: String) -> Option<Invoice> {
        self.invoices.get(&public_id).cloned()
    }

    pub fn get_bill(&self, id: String) -> Option<Bill> {
        self.bills.get(&id).cloned()
    }

    pub fn get_payee(&self, id: String) -> Option<Payee> {
        self.payees.get(&id).cloned()
    }

    pub fn get_batch(&self, id: String) -> Option<PayrollBatch> {
        self.batches.get(&id).cloned()
    }

    pub fn list_invoices_by_owner(&self, owner: AccountId, from_index: Option<u32>, limit: Option<u32>) -> Vec<Invoice> {
        page(&self.owner_invoices, &self.invoices, &owner, from_index, limit)
    }

    pub fn list_bills_by_owner(&self, owner: AccountId, from_index: Option<u32>, limit: Option<u32>) -> Vec<Bill> {
        page(&self.owner_bills, &self.bills, &owner, from_index, limit)
    }

    pub fn list_payees_by_owner(&self, owner: AccountId, from_index: Option<u32>, limit: Option<u32>) -> Vec<Payee> {
        page(&self.owner_payees, &self.payees, &owner, from_index, limit)
    }

    pub fn list_batches_by_owner(
        &self,
        owner: AccountId,
        from_index: Option<u32>,
        limit: Option<u32>,
    ) -> Vec<PayrollBatch> {
        page(&self.owner_batches, &self.batches, &owner, from_index, limit)
    }

    pub fn get_key(&self, owner: AccountId, public_key: String) -> Option<KeyInfo> {
        let key = parse_ed25519_key(&public_key);
        self.keys.get(&(owner, key)).cloned()
    }

    pub fn is_nonce_used(&self, nonce: String) -> bool {
        self.nonces.contains(&decode_nonce(&nonce))
    }
}

impl FrenzyPay {
    fn ensure_contract_owner(&self) {
        if env::predecessor_account_id() != self.owner_id {
            env::panic_str("ERR_NOT_OWNER");
        }
    }

    fn ensure_relayer(&self) {
        if env::predecessor_account_id() != self.relayer_id {
            env::panic_str("ERR_NOT_RELAYER");
        }
    }

    fn store_key(&mut self, owner: AccountId, key: [u8; 32], source: KeySource) {
        let map_key = (owner.clone(), key);
        if !self.keys.contains_key(&map_key) {
            let count = self.key_counts.get(&owner).copied().unwrap_or(0);
            if count >= MAX_KEYS_PER_OWNER {
                env::panic_str("ERR_TOO_MANY_KEYS");
            }
            self.key_counts.insert(owner.clone(), count + 1);
        }
        self.keys.insert(map_key, KeyInfo { source, registered_at_ms: now_ms() });
        emit(
            "key_registered",
            json!({ "owner": owner, "public_key": ed25519_key_string(&key), "source": source }),
        );
    }

    /// Verifies the relayer caller, the owner's NEP-413 signature over this exact action and
    /// payload, burns the nonce, and checks (or relayer-attests) the signing key.
    fn authorize(&mut self, action: &str, payload: &str, auth: &SignedAuth) {
        self.ensure_relayer();
        if payload.len() > validate::MAX_PAYLOAD_BYTES {
            env::panic_str("ERR_PAYLOAD_TOO_LARGE");
        }
        let key = parse_ed25519_key(&auth.public_key);
        let nonce = decode_nonce(&auth.nonce);
        let signature = decode_signature(&auth.signature);
        let message = record_message(action, &auth.owner, payload);
        let hash = nep413_hash(&message, &nonce, env::current_account_id().as_str());
        if !env::ed25519_verify(&signature, hash, &key) {
            env::panic_str("ERR_BAD_SIGNATURE");
        }
        if !self.nonces.insert(nonce) {
            env::panic_str("ERR_NONCE_USED");
        }
        if !self.keys.contains_key(&(auth.owner.clone(), key)) {
            if !auth.attest_key {
                env::panic_str("ERR_KEY_NOT_REGISTERED");
            }
            self.store_key(auth.owner.clone(), key, KeySource::Relayer);
        }
    }
}
