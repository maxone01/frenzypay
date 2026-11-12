// One-click payment plans for the pay page: given the 1Click token, the deposit address and the exact amountIn
// (base units) of a payment attempt, the transaction the payer's wallet is asked to send. Pure, so it is
// unit-tested; src/wallet/evm.ts and src/wallet/near.ts only carry the plan to the wallet.
//
// A plan is only built when every part is unambiguous. Anything else (unknown asset id shape, a memo, a chain
// without wallet support here) returns null, and the page keeps the copy-address flow.

/** What /api/tokens returns per token. `contractAddress` is the token contract on its own chain, when 1Click lists one. */
export type PayToken = { assetId: string; symbol: string; blockchain: string; decimals: number; contractAddress?: string };

type EvmChain = { id: number; name: string; currency: { name: string; symbol: string; decimals: 18 }; rpc: string; explorer: string };

/** The EVM chains shared/address.ts validates, with what wallet_addEthereumChain needs. */
export const EVM_CHAINS: Record<string, EvmChain> = {
  eth: { id: 1, name: "Ethereum", currency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpc: "https://cloudflare-eth.com", explorer: "https://etherscan.io" },
  base: { id: 8453, name: "Base", currency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpc: "https://mainnet.base.org", explorer: "https://basescan.org" },
  arb: { id: 42161, name: "Arbitrum One", currency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpc: "https://arb1.arbitrum.io/rpc", explorer: "https://arbiscan.io" },
  op: { id: 10, name: "OP Mainnet", currency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpc: "https://mainnet.optimism.io", explorer: "https://optimistic.etherscan.io" },
  pol: { id: 137, name: "Polygon", currency: { name: "POL", symbol: "POL", decimals: 18 }, rpc: "https://polygon-rpc.com", explorer: "https://polygonscan.com" },
  bsc: { id: 56, name: "BNB Smart Chain", currency: { name: "BNB", symbol: "BNB", decimals: 18 }, rpc: "https://bsc-dataseed.bnbchain.org", explorer: "https://bscscan.com" },
  avax: { id: 43114, name: "Avalanche C-Chain", currency: { name: "Avalanche", symbol: "AVAX", decimals: 18 }, rpc: "https://api.avax.network/ext/bc/C/rpc", explorer: "https://snowtrace.io" },
  gnosis: { id: 100, name: "Gnosis", currency: { name: "xDAI", symbol: "XDAI", decimals: 18 }, rpc: "https://rpc.gnosischain.com", explorer: "https://gnosisscan.io" },
};

export const chainById = (id: number) => Object.values(EVM_CHAINS).find((c) => c.id === id);

/** wallet_addEthereumChain parameter for a chain id we support. */
export function addChainParams(id: number) {
  const c = chainById(id);
  if (!c) throw new Error("Unsupported chain");
  return { chainId: `0x${id.toString(16)}`, chainName: c.name, nativeCurrency: c.currency, rpcUrls: [c.rpc], blockExplorerUrls: [c.explorer] };
}

export type EvmPayPlan = {
  kind: "evm";
  chain: string;
  chainId: number;
  asset: "native" | "erc20";
  /** Transaction `to`: the deposit address (native) or the token contract (ERC-20). */
  to: string;
  /** Hex wei for native, 0x0 for ERC-20. */
  value: string;
  /** transfer(depositAddress, amount) calldata for ERC-20. */
  data?: string;
  /** Token contract for ERC-20. */
  token?: string;
  depositAddress: string;
  amount: string;
};

export type NearPayPlan = { kind: "near"; contract: string; depositAddress: string; amount: string; wrapNative: boolean };
export type PayPlan = EvmPayPlan | NearPayPlan;

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const AMOUNT = /^[1-9][0-9]{0,77}$/;
const MAX_UINT256 = (1n << 256n) - 1n;
/** HOT omni bridge id suffix for a chain's native coin. */
const HOT_NATIVE = "_11111111111111111111";
const NEAR_ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

const validAmount = (a: string) => AMOUNT.test(a) && BigInt(a) <= MAX_UINT256;
const word = (hex: string) => hex.padStart(64, "0");

/** ABI calldata for ERC-20 transfer(address,uint256). */
export function erc20TransferData(to: string, amount: string): string {
  if (!EVM_ADDRESS.test(to) || !validAmount(amount)) throw new Error("Invalid transfer");
  return `0xa9059cbb${word(to.slice(2).toLowerCase())}${word(BigInt(amount).toString(16))}`;
}

/**
 * Native or ERC-20 on one of EVM_CHAINS, recognised from the 1Click asset id:
 * - native: `nep141:<chain>.omft.near` / `.omdep.near`, or HOT `nep245:v2_1.omni.hot.tg:<chainId>_111…`, with no contract;
 * - ERC-20: a contractAddress that matches the `nep141:<chain>-0x<contract>.omft.near` id, or a HOT id on that chain id.
 */
export function evmPayPlan(token: PayToken, depositAddress: string, amount: string, memo?: string): EvmPayPlan | null {
  const chain = EVM_CHAINS[token.blockchain];
  if (!chain || memo || !EVM_ADDRESS.test(depositAddress) || /^0x0{40}$/i.test(depositAddress) || !validAmount(amount)) return null;
  const id = token.assetId;
  const hot = `nep245:v2_1.omni.hot.tg:${chain.id}_`;
  const base = { kind: "evm" as const, chain: token.blockchain, chainId: chain.id, depositAddress, amount };
  if (token.contractAddress === undefined) {
    const native = id === `nep141:${token.blockchain}.omft.near` || id === `nep141:${token.blockchain}.omdep.near` || id === `${hot.slice(0, -1)}${HOT_NATIVE}`;
    return native ? { ...base, asset: "native", to: depositAddress, value: `0x${BigInt(amount).toString(16)}` } : null;
  }
  const contract = token.contractAddress;
  if (!EVM_ADDRESS.test(contract)) return null;
  const bridged = new RegExp(`^nep141:${token.blockchain}-(0x[0-9a-f]{40})\\.(omft|omdep)\\.near$`).exec(id);
  const matches = bridged ? bridged[1] === contract.toLowerCase() : id.startsWith(hot) && !id.endsWith(HOT_NATIVE);
  if (!matches) return null;
  return { ...base, asset: "erc20", to: contract, value: "0x0", data: erc20TransferData(depositAddress, amount), token: contract };
}

/** NEP-141 on NEAR (`nep141:<contract>`). wrap.near is paid from native NEAR: wrapped and sent in one transaction. */
export function nearPayPlan(token: PayToken, depositAddress: string, amount: string, memo?: string): NearPayPlan | null {
  if (token.blockchain !== "near" || memo || !validAmount(amount)) return null;
  const m = /^nep141:(.+)$/.exec(token.assetId);
  const contract = m?.[1];
  if (!contract || !NEAR_ACCOUNT.test(contract)) return null;
  if (token.contractAddress !== undefined && token.contractAddress !== contract) return null;
  if (!(/^[a-f0-9]{64}$/.test(depositAddress) || NEAR_ACCOUNT.test(depositAddress))) return null;
  return { kind: "near", contract, depositAddress, amount, wrapNative: contract === "wrap.near" };
}

export function payPlan(token: PayToken | undefined, depositAddress: string, amount: string, memo?: string): PayPlan | null {
  if (!token) return null;
  return evmPayPlan(token, depositAddress, amount, memo) ?? nearPayPlan(token, depositAddress, amount, memo);
}

/** Standard NEP-145 minimum; registration_only refunds it when the account is already registered. */
export const NEAR_STORAGE_DEPOSIT = "1250000000000000000000";
const TGAS = "000000000000";

export type NearFunctionCall = { type: "FunctionCall"; params: { methodName: string; args: object; gas: string; deposit: string } };

/**
 * Actions on the token contract, in one transaction: register the deposit address for storage, (wrap.near
 * only) register the payer and wrap native NEAR, then ft_transfer the exact amount with 1 yoctoNEAR.
 */
export function nearPayActions(plan: NearPayPlan, signerId: string): NearFunctionCall[] {
  const call = (methodName: string, args: object, gas: string, deposit: string): NearFunctionCall => ({ type: "FunctionCall", params: { methodName, args, gas: gas + TGAS, deposit } });
  return [
    call("storage_deposit", { account_id: plan.depositAddress, registration_only: true }, "30", NEAR_STORAGE_DEPOSIT),
    ...(plan.wrapNative
      ? [call("storage_deposit", { account_id: signerId, registration_only: true }, "30", NEAR_STORAGE_DEPOSIT), call("near_deposit", {}, "10", plan.amount)]
      : []),
    call("ft_transfer", { receiver_id: plan.depositAddress, amount: plan.amount }, "30", "1"),
  ];
}

/** EIP-681 payment URI, for a mobile wallet when there is no browser wallet. */
export function eip681(plan: EvmPayPlan): string {
  return plan.asset === "native"
    ? `ethereum:${plan.depositAddress}@${plan.chainId}?value=${plan.amount}`
    : `ethereum:${plan.token}@${plan.chainId}/transfer?address=${plan.depositAddress}&uint256=${plan.amount}`;
}
