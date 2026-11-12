// near-connect's wallet modal renders each wallet as a clickable <div>, which a keyboard cannot reach. While a
// connect is pending this upgrades the rows to focusable buttons, labels the dialog, focuses the first wallet
// once the modal is visible, and returns focus to whatever opened it. Escape and the backdrop already close
// the modal (the library handles both).

export function enhanceWalletModal(root: ParentNode, focusFirst: boolean): void {
  for (const popup of Array.from(root.querySelectorAll<HTMLElement>(".hot-connector-popup"))) {
    const dialog = popup.querySelector<HTMLElement>(".modal-content");
    if (dialog && !dialog.hasAttribute("role")) {
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-label", "Choose a NEAR wallet");
    }
    const items = Array.from(popup.querySelectorAll<HTMLElement>(".connect-item"));
    for (const item of items) {
      if (item.getAttribute("role") === "button") continue;
      item.setAttribute("role", "button");
      item.tabIndex = 0;
      const name = item.querySelector(".connect-item-info span")?.textContent?.trim();
      if (name) item.setAttribute("aria-label", name);
      item.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        item.click();
      });
    }
    const visible = popup.style.display !== "none";
    const active = popup.ownerDocument.activeElement;
    if (focusFirst && visible && items[0] && !(active && popup.contains(active))) items[0].focus();
  }
}

/** Watch for the modal until the returned function is called. A no-op outside a browser. */
export function watchWalletModal(): () => void {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return () => {};
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const run = () => enhanceWalletModal(document, true);
  const mo = new MutationObserver(run);
  mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["style"] });
  run();
  return () => {
    mo.disconnect();
    if (opener?.isConnected && !opener.hasAttribute("disabled")) opener.focus();
  };
}
