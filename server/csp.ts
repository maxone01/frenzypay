// Content-Security-Policy for the app's HTML. It lives here and not in public/_headers because
// @hot-labs/near-connect runs each wallet in a sandboxed `srcdoc` iframe, and a srcdoc document inherits this
// page's policy: its two inline <script>s only run if they carry this response's nonce (passed to the
// connector as `cspNonce`). functions/_middleware.ts adds the nonce to every HTML response.
//
// Every origin beyond 'self' is there for the two wallets in shared/near-connect-manifest.ts. The iframe's
// fetches and sockets fall under this same connect-src.
import { NEAR_CONNECT_RPC, NEAR_CONNECT_WALLETS } from "../shared/near-connect-manifest.ts";

const WALLET_CONNECT_SRC = [
  // The pinned executor scripts, by exact path: the connector fetches them before building the iframe.
  ...NEAR_CONNECT_WALLETS.map((w) => w.executor),
  // HOT: request relay and the clock it signs against.
  "https://h4n.app",
  "https://api0.herewallet.app",
  // Meteor: connect bridge (HTTP and WebSocket).
  "https://mc.meteorwallet.app",
  "wss://mc.meteorwallet.app",
  // RPC handed to the wallets as `providers.mainnet`.
  NEAR_CONNECT_RPC,
];

// HOT's icon and the logo HOT's own connect screen shows. Meteor's icon is a data: URI.
const WALLET_IMG_SRC = ["https://storage.herewallet.app"];

export function contentSecurityPolicy(nonce: string): string {
  if (!/^[A-Za-z0-9+/=_-]{16,}$/.test(nonce)) throw new Error("Invalid CSP nonce");
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    `connect-src 'self' ${WALLET_CONNECT_SRC.join(" ")}`,
    `img-src 'self' data: ${WALLET_IMG_SRC.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

/** 128 random bits, base64. */
export function newNonce(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b));
}

/** Adds `nonce` to every <script> tag. The input is our own built index.html, not user content. */
export function addScriptNonce(html: string, nonce: string): string {
  return html.replace(/<script\b(?![^>]*\snonce=)/gi, `<script nonce="${nonce}"`);
}

/** Request headers that could get a cached copy of the HTML (with an old nonce) revalidated with a 304. */
export function withoutConditionalHeaders(req: Request): Request {
  const headers = new Headers(req.headers);
  headers.delete("if-none-match");
  headers.delete("if-modified-since");
  return new Request(req, { headers });
}

/**
 * HTML responses get a fresh nonce on their scripts and the matching CSP; everything else passes through.
 * The HTML is small (one built index.html), so it is rewritten as text.
 */
export async function withDocumentCsp(res: Response, nonce = newNonce()): Promise<Response> {
  if (!(res.headers.get("content-type") ?? "").toLowerCase().startsWith("text/html")) return res;
  const headers = new Headers(res.headers);
  headers.set("Content-Security-Policy", contentSecurityPolicy(nonce));
  // A nonce must never be reused, so this HTML is never served from a cache.
  headers.set("Cache-Control", "no-store");
  headers.delete("ETag");
  headers.delete("Last-Modified");
  headers.delete("Content-Length");
  return new Response(addScriptNonce(await res.text(), nonce), { status: res.status, statusText: res.statusText, headers });
}
