# FrenzyPay contract: mainnet setup (manual, owner only)

You run these steps yourself with near-cli-rs (the `near` command). Nothing in the repo runs them
automatically.

> **Warnings**
> - Never deploy code onto `maxkumbang.near`. The contract goes on its own subaccount,
>   `frenzypay.maxkumbang.near`.
> - Everything written to the contract is public and permanent.
> - A dry run on a testnet account first is optional but recommended. Use the same steps with
>   `testnet`, `*.testnet` accounts and `--yes-testnet`. This is also how you confirm the VM
>   accepts the wasm, see the contracts/frenzypay README.

Accounts used below:

| Variable | Value |
|---|---|
| `OWNER` | `maxkumbang.near` (wallet, contract owner, and relayer) |
| `CONTRACT` | `frenzypay.maxkumbang.near` |

## 1. Create the contract subaccount

The code is about 384 kB, so storing it locks about 3.85 NEAR (0.00001 NEAR per byte). Every
record then locks roughly 0.01 NEAR more.

- 5 NEAR leaves only about 1 NEAR for records.
- **6 NEAR is the suggested minimum.** You can top up later with a plain transfer.

```bash
near account create-account fund-myself frenzypay.maxkumbang.near '6 NEAR' \
  autogenerate-new-keypair save-to-keychain \
  sign-as maxkumbang.near network-config mainnet sign-with-keychain send
```

## 2. Deploy the wasm

Deploy with the script:

```bash
CONTRACT_ID=frenzypay.maxkumbang.near NEAR_NETWORK=mainnet ./scripts/deploy-contract.sh --yes-mainnet
```

Or build and deploy by hand:

```bash
RUSTFLAGS="-C target-cpu=mvp" CARGO_TARGET_DIR=$HOME/.cache/frenzypay-contract-target \
  cargo build --manifest-path contracts/frenzypay/Cargo.toml --target wasm32-unknown-unknown --release
near contract deploy frenzypay.maxkumbang.near \
  use-file $HOME/.cache/frenzypay-contract-target/wasm32-unknown-unknown/release/frenzypay.wasm \
  without-init-call network-config mainnet sign-with-keychain send
```

## 3. Initialize

```bash
near contract call-function as-transaction frenzypay.maxkumbang.near new \
  json-args '{"owner_id":"maxkumbang.near","relayer_id":"maxkumbang.near"}' \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
  sign-as frenzypay.maxkumbang.near network-config mainnet sign-with-keychain send
```

## 4. Relayer key on maxkumbang.near

Add a function-call access key to `maxkumbang.near` that can only call the write methods on the
contract:

```bash
near account add-key maxkumbang.near \
  grant-function-call-access \
  --allowance '1 NEAR' \
  --contract-account-id frenzypay.maxkumbang.near \
  --function-names 'put_invoice, cancel_invoice, mark_invoice_paid, put_bill, cancel_bill, mark_bill_paid, put_payee, remove_payee, put_batch, mark_payroll_line_paid' \
  autogenerate-new-keypair print-to-terminal \
  network-config mainnet sign-with-keychain send
```

`print-to-terminal` prints the new keypair, generated locally. Copy it straight into the secrets
below, then clear your terminal scrollback.

Put the values into Cloudflare Pages. Run each command and paste the value when prompted.
`NEAR_RPC_URL` is already a plain variable in `wrangler.toml` (mainnet fastnear); leave it there.
For local `npm run dev:api`, the same names go in `.env` instead (never commit it).

```bash
npx wrangler pages secret put RELAYER_PRIVATE_KEY  --project-name frenzypay  # ed25519:... (secret key, from print-to-terminal)
npx wrangler pages secret put RELAYER_PUBLIC_KEY   --project-name frenzypay  # ed25519:... (its public key)
npx wrangler pages secret put RELAYER_ACCOUNT_ID   --project-name frenzypay  # maxkumbang.near
npx wrangler pages secret put CONTRACT_ID          --project-name frenzypay  # frenzypay.maxkumbang.near
npx wrangler pages secret put CONTRACT_OWNER_ID    --project-name frenzypay  # maxkumbang.near (scripts only; harmless here)
npx wrangler pages secret put NEAR_NETWORK         --project-name frenzypay  # mainnet
```

The server refuses to write if `RELAYER_PRIVATE_KEY` does not match `RELAYER_PUBLIC_KEY` (it logs that, without the key).
Setting `CONTRACT_ID` alone already lets pay links fall back to the on-chain record; it writes nothing.

**Only after step 5 checks out**, turn on writes (records on mainnet are permanent and public):

```bash
npx wrangler pages secret put CHAIN_WRITES_ENABLED --project-name frenzypay  # true
```

To stop writing at any time, set `CHAIN_WRITES_ENABLED` to `false` (or delete it). To cut the relayer off entirely,
delete the function-call key: `near account delete-keys maxkumbang.near public-keys <ed25519:...> network-config mainnet sign-with-keychain send`.

## 5. Verify

```bash
near contract call-function as-read-only frenzypay.maxkumbang.near get_config json-args '{}' network-config mainnet now
# -> {"owner_id":"maxkumbang.near","relayer_id":"maxkumbang.near"}
near account list-keys maxkumbang.near network-config mainnet now
# -> the new function-call key with receiver frenzypay.maxkumbang.near and the 10 methods
near contract call-function as-read-only frenzypay.maxkumbang.near list_invoices_by_owner \
  json-args '{"owner":"maxkumbang.near"}' network-config mainnet now
# -> []
near account view-account-summary frenzypay.maxkumbang.near network-config mainnet now
# -> balance and storage usage
```

After the server writes its first record, check it with `get_invoice` and look at the transaction
logs for the `EVENT_JSON:{"standard":"frenzypay",...}` lines.

Optional, and recommended: register your wallet key yourself. Then the relayer never has to vouch
for that key.

```bash
near contract call-function as-transaction frenzypay.maxkumbang.near register_key \
  json-args '{"public_key":"ed25519:<your wallet full-access public key>"}' \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
  sign-as maxkumbang.near network-config mainnet sign-with-keychain send
```
