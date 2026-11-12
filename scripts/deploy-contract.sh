#!/usr/bin/env bash
# Builds contracts/frenzypay and deploys the wasm to $CONTRACT_ID with near-cli-rs.
#
#   CONTRACT_ID=frenzypay.maxkumbang.near ./scripts/deploy-contract.sh --yes-mainnet
#   NEAR_NETWORK=testnet CONTRACT_ID=frenzypay.someone.testnet ./scripts/deploy-contract.sh --yes-testnet
#
# Values already in the environment win over .env. Deploys code only (no init call); run
# `new` separately, see scripts/setup-mainnet.md. Never deploy onto a wallet account.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE="$ROOT/contracts/frenzypay"

usage() {
  echo "usage: $0 --yes-mainnet | --yes-testnet" >&2
  echo "  reads CONTRACT_ID, NEAR_NETWORK (default mainnet), CONTRACT_OWNER_ID, RELAYER_ACCOUNT_ID from env or .env" >&2
}

CONFIRM=""
for arg in "$@"; do
  case "$arg" in
    --yes-mainnet) CONFIRM="mainnet" ;;
    --yes-testnet) CONFIRM="testnet" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; usage; exit 2 ;;
  esac
done

# Load .env without letting it override values passed explicitly, and without printing anything.
pre_contract="${CONTRACT_ID-}"
pre_network="${NEAR_NETWORK-}"
pre_owner="${CONTRACT_OWNER_ID-}"
pre_relayer="${RELAYER_ACCOUNT_ID-}"
if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi
CONTRACT_ID="${pre_contract:-${CONTRACT_ID-}}"
NEAR_NETWORK="${pre_network:-${NEAR_NETWORK:-mainnet}}"
CONTRACT_OWNER_ID="${pre_owner:-${CONTRACT_OWNER_ID-}}"
RELAYER_ACCOUNT_ID="${pre_relayer:-${RELAYER_ACCOUNT_ID-}}"

case "$NEAR_NETWORK" in
  mainnet|testnet) ;;
  *) echo "NEAR_NETWORK must be mainnet or testnet (got '$NEAR_NETWORK')" >&2; exit 2 ;;
esac

if [[ "$CONFIRM" != "$NEAR_NETWORK" ]]; then
  echo "Refusing to deploy: NEAR_NETWORK=$NEAR_NETWORK requires --yes-$NEAR_NETWORK." >&2
  exit 2
fi

if [[ -z "$CONTRACT_ID" ]]; then
  echo "Refusing to deploy: CONTRACT_ID is empty." >&2
  exit 2
fi
if [[ ! "$CONTRACT_ID" =~ ^[a-z0-9_-]+(\.[a-z0-9_-]+){2,}$ ]]; then
  echo "Refusing to deploy: CONTRACT_ID '$CONTRACT_ID' is not a dot-subaccount (expected e.g. frenzypay.<you>.near)." >&2
  exit 2
fi
case "$NEAR_NETWORK:$CONTRACT_ID" in
  mainnet:*.near|testnet:*.testnet) ;;
  *) echo "Refusing to deploy: CONTRACT_ID '$CONTRACT_ID' does not belong to $NEAR_NETWORK." >&2; exit 2 ;;
esac
if [[ -n "$CONTRACT_OWNER_ID" && "$CONTRACT_ID" == "$CONTRACT_OWNER_ID" ]]; then
  echo "Refusing to deploy: CONTRACT_ID equals CONTRACT_OWNER_ID (never deploy code onto the wallet account)." >&2
  exit 2
fi
if [[ -n "$RELAYER_ACCOUNT_ID" && "$CONTRACT_ID" == "$RELAYER_ACCOUNT_ID" ]]; then
  echo "Refusing to deploy: CONTRACT_ID equals RELAYER_ACCOUNT_ID." >&2
  exit 2
fi

command -v cargo >/dev/null || { echo "cargo not found" >&2; exit 1; }
command -v near >/dev/null || { echo "near (near-cli-rs) not found" >&2; exit 1; }

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/frenzypay-contract-target}"
# Rust >= 1.82 enables post-MVP wasm features by default; target-cpu=mvp turns them off for our code.
RUSTFLAGS="-C target-cpu=mvp" cargo build \
  --manifest-path "$CRATE/Cargo.toml" \
  --target wasm32-unknown-unknown \
  --release

WASM="$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/frenzypay.wasm"
[[ -f "$WASM" ]] || { echo "wasm not found at $WASM" >&2; exit 1; }
SIZE="$(wc -c < "$WASM" | tr -d ' ')"
COST="$(awk -v b="$SIZE" 'BEGIN { printf "%.2f", b * 0.00001 }')"

echo
echo "wasm:      $WASM"
echo "size:      $SIZE bytes"
echo "storage:   ~$COST NEAR locked on $CONTRACT_ID for the code alone (1e19 yocto/byte)"
echo "target:    $CONTRACT_ID"
echo "network:   $NEAR_NETWORK"
echo

# Last stop before a real deploy: type the account back. Without a terminal, --yes-<network> alone confirms.
if [[ -t 0 ]]; then
  read -r -p "Type the contract account ($CONTRACT_ID) to deploy, anything else aborts: " answer
  [[ "$answer" == "$CONTRACT_ID" ]] || { echo "Aborted; nothing deployed." >&2; exit 1; }
fi

near contract deploy "$CONTRACT_ID" \
  use-file "$WASM" \
  without-init-call \
  network-config "$NEAR_NETWORK" \
  sign-with-keychain \
  send
