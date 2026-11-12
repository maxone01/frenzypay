import test from "node:test";
import assert from "node:assert/strict";
import { comboboxHtml, countText, filterItems, type ComboItem } from "../../src/ui/combobox.ts";

const items: ComboItem[] = [
  { value: "a", symbol: "wETH", chain: "NEAR", keywords: "near" },
  { value: "b", symbol: "USDC", chain: "Arbitrum", keywords: "arb" },
  { value: "c", symbol: "ETH", chain: "Ethereum", keywords: "eth" },
  { value: "d", symbol: "ETHFI", chain: "Ethereum", keywords: "eth" },
];

test("filterItems: exact symbol, then prefix, then other matches; empty query keeps order", () => {
  assert.deepEqual(filterItems(items, "").map((i) => i.value), ["a", "b", "c", "d"]);
  assert.deepEqual(filterItems(items, "eth").map((i) => i.value), ["c", "d", "a"]);
  assert.deepEqual(filterItems(items, "  ARB ").map((i) => i.value), ["b"]);
  assert.deepEqual(filterItems(items, "zzz"), []);
});

test("countText: says when matches were cut off", () => {
  assert.equal(countText(3, 3, 10), "Showing 3 of 10");
  assert.equal(countText(100, 240, 300), "Showing 100 of 240 matches. Keep typing to narrow the list.");
});

test("comboboxHtml: escapes token text and drops the chain tag when every item shares a chain", () => {
  const html = comboboxHtml({ id: "x", label: "Pick", items: [{ value: "v", symbol: "<b>", chain: "NEAR" }], value: "v", onChange: () => {} });
  assert.ok(!html.includes("<b>"));
  assert.match(html, /value="&lt;b&gt;"/);
  assert.match(html, /class="cb-tag cb-sel-tag" id="x-chain" hidden/);
  const mixed = comboboxHtml({ id: "y", label: "Pick", items, value: "b", onChange: () => {} });
  assert.match(mixed, /aria-describedby="y-chain"/);
  assert.match(mixed, />Arbitrum</);
});
