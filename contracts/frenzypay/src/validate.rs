//! Field validation for record payloads. Every check panics with a stable `ERR_*` code so the
//! relaying server can map failures without parsing prose.

use near_sdk::env;
use near_sdk::json_types::U128;

pub const MAX_PAYLOAD_BYTES: usize = 16_384;
pub const MAX_TEXT_CHARS: usize = 280;
pub const MAX_NAME_CHARS: usize = 100;
pub const MAX_ID_CHARS: usize = 64;
pub const MIN_PUBLIC_ID_CHARS: usize = 16;
pub const MAX_INVOICE_ITEMS: usize = 10;
pub const MAX_PAYROLL_LINES: usize = 50;

fn fail(code: &str, field: &str) -> ! {
    env::panic_str(&format!("{code}: {field}"))
}

fn id_chars_ok(value: &str) -> bool {
    value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `^[A-Za-z0-9_-]{1,64}$`
pub fn id(field: &str, value: &str) {
    if value.is_empty() || value.len() > MAX_ID_CHARS || !id_chars_ok(value) {
        fail("ERR_BAD_ID", field);
    }
}

/// `^[A-Za-z0-9_-]{16,64}$`
pub fn public_id(field: &str, value: &str) {
    if value.len() < MIN_PUBLIC_ID_CHARS || value.len() > MAX_ID_CHARS || !id_chars_ok(value) {
        fail("ERR_BAD_ID", field);
    }
}

/// Free text up to 280 characters (may be empty).
pub fn text(field: &str, value: &str) {
    if value.chars().count() > MAX_TEXT_CHARS {
        fail("ERR_TOO_LONG", field);
    }
}

/// Non-empty free text up to 280 characters.
pub fn required_text(field: &str, value: &str) {
    if value.trim().is_empty() {
        fail("ERR_EMPTY", field);
    }
    text(field, value);
}

/// Non-empty name up to 100 characters.
pub fn name(field: &str, value: &str) {
    if value.trim().is_empty() {
        fail("ERR_EMPTY", field);
    }
    if value.chars().count() > MAX_NAME_CHARS {
        fail("ERR_TOO_LONG", field);
    }
}

/// `YYYY-MM-DD` shape (digits and dashes in the right places; not a calendar check).
pub fn date(field: &str, value: &str) {
    let b = value.as_bytes();
    let ok = b.len() == 10
        && b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() });
    if !ok {
        fail("ERR_BAD_DATE", field);
    }
}

/// Amounts must be strictly positive.
pub fn amount(field: &str, value: U128) {
    if value.0 == 0 {
        fail("ERR_BAD_AMOUNT", field);
    }
}
