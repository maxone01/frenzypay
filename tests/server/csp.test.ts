import { test } from "node:test";
import assert from "node:assert/strict";
import { addScriptNonce, contentSecurityPolicy, newNonce, withDocumentCsp, withoutConditionalHeaders } from "../../server/csp.ts";
import { NEAR_CONNECT_RPC, NEAR_CONNECT_WALLETS } from "../../shared/near-connect-manifest.ts";

const directive = (csp: string, name: string) =>
  csp
    .split(";")
    .map((d) => d.trim().split(/\s+/))
    .find(([n]) => n === name)
    ?.slice(1) ?? null;

test("script-src is 'self' plus this response's nonce, never unsafe-inline or unsafe-eval", () => {
  const csp = contentSecurityPolicy("abcdefghijklmnopqrstuv==");
  assert.deepEqual(directive(csp, "script-src"), ["'self'", "'nonce-abcdefghijklmnopqrstuv=='"]);
  assert.ok(!csp.includes("unsafe-eval"));
  assert.deepEqual(directive(csp, "style-src"), ["'self'", "'unsafe-inline'"]);
  assert.deepEqual(directive(csp, "frame-ancestors"), ["'none'"]);
  assert.deepEqual(directive(csp, "object-src"), ["'none'"]);
});

test("connect-src allows each pinned executor by exact path, the wallet backends and the RPC, nothing broader", () => {
  const connect = directive(contentSecurityPolicy(newNonce()), "connect-src")!;
  for (const w of NEAR_CONNECT_WALLETS) assert.ok(connect.includes(w.executor), `${w.id} executor missing from connect-src`);
  assert.ok(connect.includes(NEAR_CONNECT_RPC));
  assert.ok(!connect.includes("https://raw.githubusercontent.com"), "the whole of raw.githubusercontent.com must not be allowed");
  assert.ok(!connect.some((s) => s.includes("*")));
  assert.deepEqual(
    connect.filter((s) => !NEAR_CONNECT_WALLETS.some((w) => w.executor === s)).sort(),
    ["'self'", "https://api0.herewallet.app", "https://free.rpc.fastnear.com", "https://h4n.app", "https://mc.meteorwallet.app", "wss://mc.meteorwallet.app"],
  );
});

test("every wallet icon loads under img-src", () => {
  const img = directive(contentSecurityPolicy(newNonce()), "img-src")!;
  for (const w of NEAR_CONNECT_WALLETS) {
    if (w.icon.startsWith("data:")) assert.ok(img.includes("data:"));
    else assert.ok(img.includes(new URL(w.icon).origin), `${w.id} icon origin missing from img-src`);
  }
});

test("a malformed nonce is refused rather than written into the header", () => {
  assert.throws(() => contentSecurityPolicy("x'; script-src *"));
  assert.throws(() => contentSecurityPolicy(""));
});

test("newNonce: 128 random bits, different every call", () => {
  const a = newNonce();
  assert.equal(atob(a).length, 16);
  assert.notEqual(a, newNonce());
});

test("addScriptNonce tags every script once", () => {
  const html = `<head><script type="module" crossorigin src="/assets/a.js"></script><SCRIPT>x</SCRIPT><script nonce="old"></script></head>`;
  const out = addScriptNonce(html, "N0NCE");
  assert.equal(out.match(/nonce="N0NCE"/g)?.length, 2);
  assert.match(out, /<script nonce="N0NCE" type="module"/);
  assert.match(out, /<script nonce="old">/);
});

test("withDocumentCsp sets the matching policy on HTML and makes it uncacheable", async () => {
  const res = new Response(`<html><script type="module" src="/assets/a.js"></script></html>`, {
    headers: { "content-type": "text/html; charset=utf-8", etag: '"abc"', "cache-control": "public, max-age=3600" },
  });
  const out = await withDocumentCsp(res, "abcdefghijklmnopqrstuv==");
  assert.match(await out.text(), /<script nonce="abcdefghijklmnopqrstuv==" type="module"/);
  assert.match(out.headers.get("content-security-policy")!, /'nonce-abcdefghijklmnopqrstuv=='/);
  assert.equal(out.headers.get("cache-control"), "no-store");
  assert.equal(out.headers.get("etag"), null);
});

test("withDocumentCsp leaves non-HTML responses alone", async () => {
  const res = new Response("{}", { headers: { "content-type": "application/json" } });
  assert.equal(await withDocumentCsp(res), res);
});

test("withoutConditionalHeaders drops revalidation headers so a cached page never meets a new nonce", () => {
  const req = new Request("https://frenzypay.app/", { headers: { "if-none-match": '"abc"', "if-modified-since": "x", accept: "text/html" } });
  const out = withoutConditionalHeaders(req);
  assert.equal(out.headers.get("if-none-match"), null);
  assert.equal(out.headers.get("if-modified-since"), null);
  assert.equal(out.headers.get("accept"), "text/html");
});
