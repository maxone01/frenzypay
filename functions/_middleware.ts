import { withDocumentCsp, withoutConditionalHeaders } from "../server/csp.ts";

// Gives every HTML response a per-request script nonce and the matching Content-Security-Policy (server/csp.ts).
// /api responses are JSON and pass through untouched; public/_routes.json keeps static assets out of here.
export const onRequest: PagesFunction = async (ctx) => {
  const url = new URL(ctx.request.url);
  if (url.pathname.startsWith("/api/")) return ctx.next();
  const page = ctx.request.method === "GET" || ctx.request.method === "HEAD";
  const res = await ctx.next(page ? withoutConditionalHeaders(ctx.request) : ctx.request);
  return withDocumentCsp(res);
};
