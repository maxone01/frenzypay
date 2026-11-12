//! Payload inputs (parsed from the signed `payload` JSON string, unknown fields rejected) and the
//! stored record views returned by the view methods.

use near_sdk::json_types::U128;
use near_sdk::serde::Deserialize;
use near_sdk::{near, AccountId};

// ---------- enums ----------

#[near(serializers = [borsh, json])]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecipientType {
    DestinationChain,
    Intents,
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "lowercase")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BillSource {
    Manual,
    Frenzypay,
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "lowercase")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InvoiceStatus {
    Issued,
    Cancelled,
    Paid,
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "lowercase")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BillStatus {
    Scheduled,
    Cancelled,
    Paid,
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "lowercase")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeySource {
    #[serde(rename = "self")]
    SelfRegistered,
    Relayer,
}

// ---------- payload inputs ----------

#[derive(Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct InvoiceItemInput {
    pub description: String,
    pub quantity: String,
    pub unit_price: String,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct InvoiceInput {
    pub public_id: String,
    pub number: String,
    pub issuer: String,
    pub client: String,
    pub due_date: String,
    pub token_id: String,
    pub total: U128,
    pub notes: String,
    pub items: Vec<InvoiceItemInput>,
    pub created_at: String,
    pub issued_at: String,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct PublicIdInput {
    pub public_id: String,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct IdInput {
    pub id: String,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct BillInput {
    pub id: String,
    pub vendor: String,
    pub reference: String,
    pub due_date: String,
    pub destination_asset: String,
    pub recipient_type: RecipientType,
    pub recipient: String,
    pub amount: U128,
    pub source: BillSource,
    #[serde(default)]
    pub vendor_public_id: Option<String>,
    pub created_at: String,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct PayeeInput {
    pub id: String,
    pub name: String,
    pub destination_asset: String,
    pub recipient_type: RecipientType,
    pub recipient: String,
    pub created_at: String,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct PayrollLineInput {
    pub n: u32,
    pub name: String,
    pub destination_asset: String,
    pub recipient_type: RecipientType,
    pub recipient: String,
    pub amount: U128,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct BatchInput {
    pub id: String,
    pub title: String,
    pub origin_asset: String,
    pub created_at: String,
    pub lines: Vec<PayrollLineInput>,
}

// ---------- stored records / views ----------
// Optional fields are always serialized (as `null` when unset) so every view has a fixed shape.

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct InvoiceItem {
    pub description: String,
    pub quantity: String,
    pub unit_price: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Invoice {
    pub public_id: String,
    pub owner: AccountId,
    pub number: String,
    pub issuer: String,
    pub client: String,
    pub due_date: String,
    pub token_id: String,
    pub total: U128,
    pub notes: String,
    pub items: Vec<InvoiceItem>,
    pub created_at: String,
    pub issued_at: String,
    pub status: InvoiceStatus,
    pub recorded_at_ms: u64,
    pub updated_at_ms: u64,
    pub cancelled_at_ms: Option<u64>,
    pub paid_at_ms: Option<u64>,
    pub paid_by: Option<String>,
    pub paid_tx_hash: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Bill {
    pub id: String,
    pub owner: AccountId,
    pub vendor: String,
    pub reference: String,
    pub due_date: String,
    pub destination_asset: String,
    pub recipient_type: RecipientType,
    pub recipient: String,
    pub amount: U128,
    pub source: BillSource,
    pub vendor_public_id: Option<String>,
    pub created_at: String,
    pub status: BillStatus,
    pub recorded_at_ms: u64,
    pub updated_at_ms: u64,
    pub cancelled_at_ms: Option<u64>,
    pub paid_at_ms: Option<u64>,
    pub paid_by: Option<String>,
    pub paid_tx_hash: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Payee {
    pub id: String,
    pub owner: AccountId,
    pub name: String,
    pub destination_asset: String,
    pub recipient_type: RecipientType,
    pub recipient: String,
    pub created_at: String,
    pub recorded_at_ms: u64,
    pub updated_at_ms: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PayrollLine {
    pub n: u32,
    pub name: String,
    pub destination_asset: String,
    pub recipient_type: RecipientType,
    pub recipient: String,
    pub amount: U128,
    pub paid_at_ms: Option<u64>,
    pub paid_by: Option<String>,
    pub paid_tx_hash: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PayrollBatch {
    pub id: String,
    pub owner: AccountId,
    pub title: String,
    pub origin_asset: String,
    pub created_at: String,
    pub lines: Vec<PayrollLine>,
    pub recorded_at_ms: u64,
    pub updated_at_ms: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct KeyInfo {
    pub source: KeySource,
    pub registered_at_ms: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub owner_id: AccountId,
    pub relayer_id: AccountId,
}
