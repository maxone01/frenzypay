//! NEP-413 style signed authorization for owner writes.
//!
//! The owner signs (off-chain, with a wallet `signMessage` or a raw ed25519 key) the message
//!
//! ```text
//! FrenzyPay public record
//! action: <method name>
//! owner: <owner account id>
//! payload_sha256: <lowercase hex sha256 of the payload string>
//! ```
//!
//! with `recipient` = this contract's account id and a fresh 32-byte nonce. The signed bytes are
//! `sha256(borsh(2^31 + 413) ‖ borsh(message) ‖ nonce ‖ borsh(recipient) ‖ borsh(None::<String>))`.

use near_sdk::base64::engine::general_purpose::STANDARD as BASE64;
use near_sdk::base64::Engine;
use near_sdk::{env, near, AccountId};

/// NEP-413 tag: 2^31 + 413.
pub const NEP413_TAG: u32 = 2_147_484_061;

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SignedAuth {
    pub owner: AccountId,
    /// `ed25519:<base58>`
    pub public_key: String,
    /// base64 of exactly 32 bytes
    pub nonce: String,
    /// base64 of exactly 64 bytes
    pub signature: String,
    /// When the key is not registered for `owner`, register it with source "relayer" (the relayer
    /// vouches it checked off-chain that this is a full-access key of `owner`).
    pub attest_key: bool,
}

/// Parses `ed25519:<base58>` into the raw 32-byte key. Only ed25519 is accepted.
pub fn parse_ed25519_key(public_key: &str) -> [u8; 32] {
    let Some(data) = public_key.strip_prefix("ed25519:") else {
        env::panic_str("ERR_BAD_PUBLIC_KEY: only ed25519:<base58> keys are accepted")
    };
    let bytes = near_sdk::bs58::decode(data)
        .into_vec()
        .unwrap_or_else(|_| env::panic_str("ERR_BAD_PUBLIC_KEY: invalid base58"));
    bytes.try_into().unwrap_or_else(|_| env::panic_str("ERR_BAD_PUBLIC_KEY: expected 32 bytes"))
}

/// Canonical text form of a raw ed25519 key.
pub fn ed25519_key_string(key: &[u8; 32]) -> String {
    format!("ed25519:{}", near_sdk::bs58::encode(key).into_string())
}

pub fn decode_nonce(nonce: &str) -> [u8; 32] {
    BASE64
        .decode(nonce)
        .ok()
        .and_then(|b| b.try_into().ok())
        .unwrap_or_else(|| env::panic_str("ERR_BAD_NONCE: expected base64 of 32 bytes"))
}

pub fn decode_signature(signature: &str) -> [u8; 64] {
    BASE64
        .decode(signature)
        .ok()
        .and_then(|b| b.try_into().ok())
        .unwrap_or_else(|| env::panic_str("ERR_BAD_SIGNATURE"))
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

/// The human-readable message the owner signs.
pub fn record_message(action: &str, owner: &AccountId, payload: &str) -> String {
    let digest = hex_lower(&env::sha256_array(payload.as_bytes()));
    format!("FrenzyPay public record\naction: {action}\nowner: {owner}\npayload_sha256: {digest}")
}

fn push_borsh_string(out: &mut Vec<u8>, s: &str) {
    let len = u32::try_from(s.len()).unwrap_or_else(|_| env::panic_str("ERR_TOO_LONG"));
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(s.as_bytes());
}

/// sha256 of the NEP-413 payload (callback_url = None).
pub fn nep413_hash(message: &str, nonce: &[u8; 32], recipient: &str) -> [u8; 32] {
    let mut buf = Vec::with_capacity(4 + 4 + message.len() + 32 + 4 + recipient.len() + 1);
    buf.extend_from_slice(&NEP413_TAG.to_le_bytes());
    push_borsh_string(&mut buf, message);
    buf.extend_from_slice(nonce);
    push_borsh_string(&mut buf, recipient);
    buf.push(0); // Option<String>::None
    env::sha256_array(&buf)
}
