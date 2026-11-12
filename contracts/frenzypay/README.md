# FrenzyPay records contract

A NEAR contract that keeps permanent, public records of FrenzyPay invoices, bills, payees and
payroll batches. The FrenzyPay server sends every write on the owner's behalf. Each record write
carries the owner's ed25519 signature over that exact payload, so the relayer can't change a
record's content.

What goes on-chain is public and can't be deleted. The client's email address is never sent to
the contract, and no spending-policy data is stored here. Payloads hold only the fields listed
below.

## Roles

| Role | Who | Can do |
|---|---|---|
| contract owner | `owner_id` from `new` | `set_relayer`, `set_owner` |
| relayer | a single account, `relayer_id` | the only caller allowed for every record write and every `mark_*` method (`ERR_NOT_RELAYER` for anyone else) |
| record owner | `auth.owner` in a signed write | signs payloads; `register_key` / `revoke_key` for its own account |

No method takes an attached deposit. The relayer pays gas. **The contract pays for storage out of
its own balance**, so the owner has to keep the contract account funded.

## Methods

Owner writes all take `(payload: String, auth: SignedAuth)`. `payload` is a JSON string of at most
16384 bytes. It is parsed into the method's input struct, and unknown fields are rejected
(`ERR_BAD_PAYLOAD`).

| Method | Caller | Payload / args | Effect | Event |
|---|---|---|---|---|
| `new(owner_id, relayer_id)` | init | | | |
| `set_relayer(relayer_id)` | contract owner | | replace relayer | `relayer_changed` |
| `set_owner(owner_id)` | contract owner | | replace owner | `owner_changed` |
| `register_key(public_key)` | any account, for itself | `"ed25519:<base58>"` | key source `self` | `key_registered` |
| `revoke_key(public_key)` | the key's owner | | remove key | `key_revoked` |
| `put_invoice` | relayer + signature | `{public_id, number, issuer, client, due_date, token_id, total, notes, items:[{description, quantity, unit_price}], created_at, issued_at}` | create only (`ERR_EXISTS`), status `issued` | `invoice_issued` |
| `cancel_invoice` | relayer + signature | `{public_id}` | issued → cancelled | `invoice_cancelled` |
| `mark_invoice_paid(public_id, deposit_address, tx_hash?)` | relayer | | issued → paid | `invoice_paid` |
| `put_bill` | relayer + signature | `{id, vendor, reference, due_date, destination_asset, recipient_type, recipient, amount, source, vendor_public_id?, created_at}` | create, or replace while `scheduled` with the same owner | `bill_saved` |
| `cancel_bill` | relayer + signature | `{id}` | scheduled → cancelled | `bill_cancelled` |
| `mark_bill_paid(id, deposit_address, tx_hash?)` | relayer | | scheduled → paid | `bill_paid` |
| `put_payee` | relayer + signature | `{id, name, destination_asset, recipient_type, recipient, created_at}` | create or replace (same owner) | `payee_saved` |
| `remove_payee` | relayer + signature | `{id}` | delete; remove from owner index | `payee_removed` |
| `put_batch` | relayer + signature | `{id, title, origin_asset, created_at, lines:[{n, name, destination_asset, recipient_type, recipient, amount}]}` | create only | `payroll_batch_created` |
| `mark_payroll_line_paid(batch_id, n, deposit_address, tx_hash?)` | relayer | | line unpaid → paid | `payroll_line_paid` |

Views:

- `get_config()` → `{owner_id, relayer_id}`
- `get_invoice(public_id)`, `get_bill(id)`, `get_payee(id)`, `get_batch(id)` → record or `null`
- `list_invoices_by_owner(owner, from_index?, limit?)`, and the same for `list_bills_by_owner`,
  `list_payees_by_owner` and `list_batches_by_owner`. Results come back in insertion order. The
  default limit is 50 and anything above 100 is capped at 100.
- `get_key(owner, public_key)` → `{source: "self"|"relayer", registered_at_ms}` or `null`
- `is_nonce_used(nonce)` (base64) → bool

### Validation

- Ids must match `^[A-Za-z0-9_-]{1,64}$`. `public_id` and `vendor_public_id` must be 16–64 characters.
- Text fields can be up to 280 characters (`notes`, `reference`, `description`, asset ids,
  recipients). Names can be up to 100 (`number`, `issuer`, `client`, `vendor`, `name`, `title`,
  `quantity`, `unit_price`, timestamps). Lengths are counted in characters.
- Dates must have the shape `YYYY-MM-DD`.
- Amounts are U128 decimal strings and must be greater than 0.
- Invoices need 1–10 items. Payroll batches need 1–50 lines, with `n == index + 1`.
- `recipient_type` must be `DESTINATION_CHAIN` or `INTENTS`. `source` must be `manual` or `frenzypay`.

### Stored views

Each payload is stored along with `owner`, `status`, `recorded_at_ms`, `updated_at_ms`,
`cancelled_at_ms`, `paid_at_ms`, `paid_by` (the deposit address) and `paid_tx_hash`. Payroll lines
get `paid_at_ms`, `paid_by` and `paid_tx_hash` instead. Optional fields are always present and set
to `null` when unset. Amounts are serialized as strings and `*_ms` values as numbers.

Statuses:

- invoice: `issued | cancelled | paid`
- bill: `scheduled | cancelled | paid`

Status errors:

- `ERR_NOT_FOUND`
- `ERR_NOT_OWNER`
- `ERR_CANCELLED`
- `ERR_ALREADY_PAID`
- `ERR_LINE_NOT_FOUND`

## Signed message (NEP-413)

```
auth = { "owner": "<account>", "public_key": "ed25519:<base58>",
         "nonce": "<base64, 32 bytes>", "signature": "<base64, 64 bytes>", "attest_key": bool }
```

1. The caller must be the relayer.
2. `payload_sha256` is the lowercase hex sha256 of the payload string's UTF-8 bytes.
3. The message is
   `"FrenzyPay public record\naction: {method}\nowner: {owner}\npayload_sha256: {hex}"`, where
   `method` is the exact method name, e.g. `put_invoice`.
4. The signed hash is
   `sha256( u32le(2147484061) ‖ borsh(message) ‖ nonce[32] ‖ borsh(recipient) ‖ 0x00 )`.
   `recipient` is the contract account id, `borsh(String)` is a u32 LE length followed by the
   UTF-8 bytes, and the final `0x00` is `callback_url = None`. This is the same input as a wallet
   `signMessage({message, nonce, recipient})`.
5. `env::ed25519_verify` must succeed (`ERR_BAD_SIGNATURE`). Only ed25519 keys are accepted
   (`ERR_BAD_PUBLIC_KEY`).
6. Each nonce can be used once across the whole contract (`ERR_NONCE_USED`).
7. The key must already be registered for `owner` (`ERR_KEY_NOT_REGISTERED`). The exception is
   `attest_key: true`: the contract then registers the key with source `relayer` and emits
   `key_registered`. If the key is already registered, its source stays unchanged.

## Trust model

- A contract can't read another account's access keys. A key registered with source `relayer` is
  only as trustworthy as the relayer's off-chain check that the key is a FullAccess key of the
  owner (RPC `view_access_key`).
- The signature proves two things: someone held that key, and that holder approved this exact
  payload, action, owner and contract.
- Keys registered by the owner itself (`register_key`, source `self`) need no trust in anyone.
- `get_key` shows how each key was registered, so anyone can audit it.
- The relayer can't forge a record for an owner whose key it didn't attest.
- **Remaining trust in the relayer:** a malicious relayer could attest a key of its own for any
  owner and then write records in that owner's name. To remove this, an owner can call
  `register_key` themselves; their writes then never need `attest_key`. Any key attested this
  way is visible with source `relayer`.
- `revoke_key` removes a key, but the key isn't blacklisted. The relayer can attest the same key
  again later, and that shows up as a new `key_registered` event with source `relayer`.
- `mark_*_paid` methods need no owner signature. The relayer alone confirms payments it has
  checked off-chain (1Click / NEAR Intents status), so paid flags are the relayer's statement.
- The contract owner can replace the relayer (`set_relayer`). Records already written stay as
  they are.
- To limit how much storage `register_key` can make the contract pay for, each owner can have at
  most 20 keys (`ERR_TOO_MANY_KEYS`).

## Storage cost

NEAR locks 1e19 yoctoNEAR per byte, which is 0.00001 NEAR per byte or 1 NEAR per 100 kB.

- The contract code takes about 384 kB, which locks about 3.85 NEAR.
- A typical invoice record with its index entry and nonce is about 0.6–1.5 kB, roughly
  0.006–0.015 NEAR.
- Nonces are never deleted, so each write also keeps about 40–100 bytes.

The relayer only pays gas. Keep the contract account funded: storage writes fail once the balance
can't cover the storage in use.

## Build

Rust 1.82 and later enable post-MVP wasm features by default (reference-types, multivalue,
bulk-memory, sign-ext). NEAR's VM has historically rejected these. Build with
`target-cpu=mvp`:

```bash
cd contracts/frenzypay
RUSTFLAGS="-C target-cpu=mvp" CARGO_TARGET_DIR=$HOME/.cache/frenzypay-contract-target \
  cargo build --target wasm32-unknown-unknown --release
# -> $HOME/.cache/frenzypay-contract-target/wasm32-unknown-unknown/release/frenzypay.wasm
```

`target-cpu=mvp` only affects code compiled in this build. The prebuilt `std` for
`wasm32-unknown-unknown` is compiled with the newer defaults. With `lto = true` most of it is
recompiled, but this build has **not** been checked for leftover post-MVP opcodes. Before mainnet:

- inspect the wasm (`wasm-tools validate --features mvp,mutable-global frenzypay.wasm`, or
  `wasm-tools print` and grep for `memory.copy` / `memory.fill`), or
- deploy to a testnet account first. The VM rejects unsupported opcodes at deploy or first call.

If it's rejected, build with a toolchain that rebuilds std (`cargo near build`), or run the wasm
through `wasm-opt --signext-lowering --llvm-memory-copy-fill-lowering`. `wasm-opt -Oz` also makes
the file noticeably smaller.

## Test

```bash
cd contracts/frenzypay
CARGO_TARGET_DIR=$HOME/.cache/frenzypay-contract-target cargo test
```

The unit tests use near-sdk `testing_env`. They sign with ed25519-dalek using fixed seeds, through
a NEP-413 hash implementation that is separate from the contract's own.

Deployment: see `scripts/setup-mainnet.md` and `scripts/deploy-contract.sh`.
