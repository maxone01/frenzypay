import { escapeHTML as esc } from "../../shared/text.ts";
import { NEAR_WALLETS, signIn, type Kind, type NearWalletId, type Session } from "../wallet/index.ts";

// Simplified "N" mark used as a decorative stand-in, not the official NEAR logo asset.
const NEAR_MARK = `<svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true"><path fill="currentColor" d="M16.9 3.4 13 9.2c-.3.4.2.9.6.6l3.8-3.3c.1-.1.3 0 .3.2v11.1c0 .2-.3.3-.4.1L6.6 3.9A1.7 1.7 0 0 0 5.2 3h-.4C3.800 3 3 3.800 3 4.800v14.400c0 1 .8 1.800 1.800 1.800.6 0 1.200-.3 1.500-.8L10.200 15c.3-.4-.2-.9-.6-.6l-3.800 3.300c-.1.1-.3 0-.3-.2V6.400c0-.2.3-.3.4-.1l10.400 12.500c.3.400.8.600 1.400.6h.4c1 0 1.800-.8 1.800-1.800V4.800c0-1-.8-1.800-1.800-1.800-.6 0-1.200.3-1.500.4z"/></svg>`;

export function mountLogin(el: HTMLElement, onSignedIn: (s: Session) => void, notice = ""): () => void {
  let alive = true;
  // Chips sit at fixed angles on rings that turn at the same speed, so they never collide.
  const chain = (cls: string, label: string, deg: number, icon: string) => {
    const r = (deg * Math.PI) / 180;
    return `<span class="pos" style="left:${(50 + 50 * Math.sin(r)).toFixed(1)}%;top:${(50 - 50 * Math.cos(r)).toFixed(1)}%"><span class="orbit-chip ${cls}"><img src="/img/tokens/${icon}" alt="" width="18" height="18" />${label}</span></span>`;
  };
  el.innerHTML = `<section class="login">
  <div class="login-hero">
    <div class="space" aria-hidden="true"><div class="space-img"></div><div class="stars s1"></div><div class="stars s2"></div><div class="space-shade"></div></div>
    <div class="login-copy">
      <p class="eyebrow">NON-CUSTODIAL INVOICING ON <img class="ni-logo" src="/img/near-intents-white.png" alt="NEAR Intents" /></p>
      <h1>Get paid from <span class="rotator" aria-live="off"><b>any chain</b><b>Ethereum</b><b>Solana</b><b>Bitcoin</b><b>Base</b></span><br />straight into your own NEAR account.</h1>
      <p class="muted">Invoice in USDC or USDT. Your client pays with whatever token they hold. It settles into <strong>your</strong> Intents account. FrenzyPay never holds your keys or funds, and signing in does not send a transaction.</p>
    </div>
    <div class="orbit" aria-hidden="true">
      <svg class="orbit-lines" viewBox="0 0 400 400"><circle cx="200" cy="200" r="150" /><circle cx="200" cy="200" r="95" /><path d="M200 200 L200 50" /><path d="M200 200 L330 275" /><path d="M200 200 L70 275" /></svg>
      <div class="orbit-core"><span class="pulse"></span><span class="pulse p2"></span>${NEAR_MARK}<small>intents.near</small></div>
      <div class="orbit-ring r1">${chain("c1", "ETH", 0, "eth.svg")}${chain("c3", "SOL", 120, "sol.svg")}${chain("c6", "NEAR", 300, "near.png")}${chain("c2", "BTC", 240, "btc.svg")}</div>
      <div class="orbit-ring r2">${chain("c4", "USDC", 60, "usdc.svg")}${chain("c5", "USDT", 200, "usdt.svg")}</div>
    </div>
  </div>
  <div class="login-options">
    <div class="panel login-card">
      <h2><span class="near-badge sm">${NEAR_MARK}</span>NEAR account</h2>
      <p class="fine">Meteor or HOT wallet. Your Intents account is your NEAR account id.</p>
      <button class="primary full" data-connect="near" aria-expanded="false">Connect NEAR wallet</button>
      <div class="wallet-choices" hidden>${NEAR_WALLETS.map((w) => `<button class="choice" data-near="${esc(w.id)}">${esc(w.name)}</button>`).join("")}</div>
    </div>
    <div class="panel login-card">
      <h2>EVM account</h2>
      <p class="fine">Browser wallet such as MetaMask (regular accounts only, not smart-contract wallets). Your Intents account is your 0x address.</p>
      <button class="primary full" data-connect="evm">Connect EVM wallet</button>
    </div>
  </div>
  <p class="error" id="login-status" role="status">${esc(notice)}</p>
  <p class="fine powered">Powered by <img class="ni-logo dark" src="/img/near-intents.png" alt="NEAR Intents" /></p>
</section>`;
  const hero = el.querySelector<HTMLElement>(".login-hero")!;
  let raf = 0;
  let tx = 0, ty = 0, cx = 0, cy = 0;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const tick = () => {
    cx += (tx - cx) * 0.07;
    cy += (ty - cy) * 0.07;
    hero.style.setProperty("--mx", cx.toFixed(3));
    hero.style.setProperty("--my", cy.toFixed(3));
    raf = Math.abs(tx - cx) + Math.abs(ty - cy) > 0.001 ? requestAnimationFrame(tick) : 0;
  };
  const aim = (x: number, y: number) => {
    const r = hero.getBoundingClientRect();
    tx = Math.max(-1, Math.min(1, ((x - r.left) / r.width - 0.5) * 2));
    ty = Math.max(-1, Math.min(1, ((y - r.top) / r.height - 0.5) * 2));
    if (!raf) raf = requestAnimationFrame(tick);
  };
  const onMove = (e: PointerEvent) => aim(e.clientX, e.clientY);
  const onLeave = () => { tx = 0; ty = 0; if (!raf) raf = requestAnimationFrame(tick); };
  if (!reduce) {
    window.addEventListener("pointermove", onMove);
    hero.addEventListener("pointerleave", onLeave);
  }
  const status = el.querySelector<HTMLElement>("#login-status")!;
  const buttons = () => el.querySelectorAll<HTMLButtonElement>("button");
  const choices = el.querySelector<HTMLElement>(".wallet-choices")!;

  async function run(kind: Kind, nearWallet?: NearWalletId) {
    buttons().forEach((b) => (b.disabled = true));
    status.className = "fine";
    status.textContent = "Waiting for your wallet…";
    try {
      const s = await signIn(kind, nearWallet);
      if (alive) onSignedIn(s);
    } catch (e) {
      if (!alive) return;
      status.className = "error";
      const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
      status.textContent = !msg
        ? "Sign-in was cancelled or failed."
        : /failed to fetch|networkerror|load failed/i.test(msg)
          ? "Network error while contacting the wallet or server. Try again."
          : msg;
    } finally {
      if (alive) buttons().forEach((b) => (b.disabled = false));
    }
  }

  el.querySelector<HTMLButtonElement>('[data-connect="near"]')!.onclick = (e) => {
    choices.hidden = !choices.hidden;
    (e.currentTarget as HTMLElement).setAttribute("aria-expanded", String(!choices.hidden));
  };
  el.querySelector<HTMLButtonElement>('[data-connect="evm"]')!.onclick = () => run("evm");
  el.querySelectorAll<HTMLButtonElement>("[data-near]").forEach((b) => (b.onclick = () => run("near", b.dataset.near as NearWalletId)));
  return () => {
    alive = false;
    cancelAnimationFrame(raf);
    window.removeEventListener("pointermove", onMove);
  };
}
