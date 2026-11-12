import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { addChainParams, eip681, erc20TransferData, evmPayPlan, nearPayPlan, payPlan, type PayToken } from "../../shared/wallet-pay.ts";

const TOKENS = JSON.parse(readFileSync("tests/fixtures/oneclick/tokens.json", "utf8")) as PayToken[];
const find = (assetId: string) => {
  const t = TOKENS.find((x) => x.assetId === assetId);
  assert.ok(t, assetId);
  return t;
};
const DEP = "0x2222222222222222222222222222222222222222";

test("erc20TransferData encodes transfer(address,uint256)", () => {
  assert.equal(
    erc20TransferData("0x00000000000000000000000000000000000000Ab", "1000000"),
    "0xa9059cbb00000000000000000000000000000000000000000000000000000000000000ab00000000000000000000000000000000000000000000000000000000000f4240",
  );
  assert.throws(() => erc20TransferData("0x12", "1"));
  assert.throws(() => erc20TransferData(DEP, "0"));
});

test("native coin from the omft id: value is the exact amountIn to the deposit address", () => {
  const p = evmPayPlan(find("nep141:arb.omft.near"), DEP, "1000000000000000")!;
  assert.deepEqual(p, { kind: "evm", chain: "arb", chainId: 42161, depositAddress: DEP, amount: "1000000000000000", asset: "native", to: DEP, value: "0x38d7ea4c68000" });
  assert.equal(eip681(p), `ethereum:${DEP}@42161?value=1000000000000000`);
});

test("ERC-20 from the omft id: calldata to the contract, which must match contractAddress", () => {
  const usdc = find("nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near");
  const p = evmPayPlan(usdc, DEP, "710180")!;
  assert.equal(p.asset, "erc20");
  assert.equal(p.chainId, 1);
  assert.equal(p.to, "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
  assert.equal(p.value, "0x0");
  assert.equal(p.data, erc20TransferData(DEP, "710180"));
  assert.equal(eip681(p), `ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48@1/transfer?address=${DEP}&uint256=710180`);
  assert.equal(evmPayPlan({ ...usdc, contractAddress: "0x1111111111111111111111111111111111111111" }, DEP, "1"), null);
  // A contract-less id that is not a known native shape is never treated as native.
  assert.equal(evmPayPlan({ ...usdc, contractAddress: undefined }, DEP, "1"), null);
});

test("HOT omni ids: native by the 111… suffix on the right chain id, ERC-20 by contractAddress", () => {
  const bnb = find("nep245:v2_1.omni.hot.tg:56_11111111111111111111");
  assert.equal(evmPayPlan(bnb, DEP, "5")?.asset, "native");
  assert.equal(evmPayPlan(bnb, DEP, "5")?.chainId, 56);
  const usdt = find("nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g");
  assert.equal(evmPayPlan(usdt, DEP, "5")?.to, "0x55d398326f99059ff775485246999027b3197955");
  // Same id shape but listed on another chain: refused.
  assert.equal(evmPayPlan({ ...usdt, blockchain: "pol" }, DEP, "5"), null);
});

test("no plan for memos, bad deposit addresses, zero or malformed amounts, or unsupported chains", () => {
  const eth = find("nep141:eth.omft.near");
  assert.equal(evmPayPlan(eth, DEP, "1", "memo"), null);
  assert.equal(evmPayPlan(eth, "0xDEPOSIT", "1"), null);
  assert.equal(evmPayPlan(eth, "0x0000000000000000000000000000000000000000", "1"), null);
  assert.equal(evmPayPlan(eth, DEP, "0"), null);
  assert.equal(evmPayPlan(eth, DEP, "1.5"), null);
  assert.equal(evmPayPlan(eth, DEP, (1n << 256n).toString()), null);
  assert.equal(payPlan(find("nep141:sol.omft.near"), "So1anaDeposit111111111111111111111111111111", "1"), null);
  assert.equal(payPlan(undefined, DEP, "1"), null);
});

test("NEAR: NEP-141 contract from the asset id; wrap.near is paid from native NEAR", () => {
  assert.deepEqual(nearPayPlan(find("nep141:wrap.near"), "dep.near", "10"), { kind: "near", contract: "wrap.near", depositAddress: "dep.near", amount: "10", wrapNative: true });
  assert.equal(nearPayPlan(find("nep141:eth.bridge.near"), "a".repeat(64), "10")?.wrapNative, false);
  assert.equal(nearPayPlan({ ...find("nep141:eth.bridge.near"), contractAddress: "other.near" }, "dep.near", "10"), null);
  assert.equal(nearPayPlan(find("nep141:eth.bridge.near"), "Not An Account", "10"), null);
  assert.equal(nearPayPlan(find("nep141:eth.bridge.near"), "dep.near", "10", "memo"), null);
});

test("addChainParams gives wallet_addEthereumChain what it needs", () => {
  assert.deepEqual(addChainParams(8453), {
    chainId: "0x2105", chainName: "Base", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: ["https://mainnet.base.org"], blockExplorerUrls: ["https://basescan.org"],
  });
  assert.throws(() => addChainParams(999));
});
