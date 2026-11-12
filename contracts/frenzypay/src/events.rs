//! NEP-297 event logs: `EVENT_JSON:{"standard":"frenzypay","version":"1.0.0","event":..,"data":[..]}`.

use near_sdk::env;
use near_sdk::serde_json::Value;

pub const STANDARD: &str = "frenzypay";
pub const VERSION: &str = "1.0.0";

/// `event` is always one of this crate's static snake_case names, so it needs no escaping.
pub fn emit(event: &str, data: Value) {
    env::log_str(&format!(
        r#"EVENT_JSON:{{"standard":"{STANDARD}","version":"{VERSION}","event":"{event}","data":[{data}]}}"#
    ));
}
