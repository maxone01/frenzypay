// Searchable token combobox (ARIA 1.2 "editable combobox with list autocomplete").
// Views render it with comboboxHtml() inside their template string, then call wireCombobox() after the
// template is in the DOM. The combobox keeps its own open/query/active state, so typing never redraws the view;
// the view only hears about a committed choice through onChange.
import { escapeHTML as esc } from "../../shared/text.ts";

export type ComboItem = {
  value: string;
  symbol: string;
  /** Chain shown as a small tag. Dropped automatically when every item shares one chain. */
  chain?: string;
  /** Extra words the filter matches (e.g. the chain code "arb"). Not shown. */
  keywords?: string;
  /** Right-aligned secondary text, e.g. a balance. */
  meta?: string;
};

export type ComboOptions = {
  /** id of the focusable input; tests and labels target it. */
  id: string;
  label: string;
  items: ComboItem[];
  value: string;
  placeholder?: string;
  /** Shown when the filter matches nothing. */
  emptyText?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
};

/** Rows rendered at most; the count line says how many more match. */
export const MAX_ROWS = 100;

/** Self-hosted logos (CSP is img-src 'self'). Anything else gets a letter avatar. */
const LOGOS: Record<string, string> = {
  USDC: "usdc.svg", USDT: "usdt.svg", ETH: "eth.svg", WETH: "eth.svg", BTC: "btc.svg", SOL: "sol.svg", NEAR: "near.png", WNEAR: "near.png",
};
/** Letter-avatar fills, all taken from the existing status-pill palette. */
const AVATAR_TONES = 5;

function avatarHtml(symbol: string): string {
  const logo = LOGOS[symbol.toUpperCase()];
  if (logo) return `<span class="cb-avatar" aria-hidden="true"><img src="/img/tokens/${logo}" alt="" width="28" height="28"></span>`;
  const letter = (symbol.match(/[A-Za-z0-9]/)?.[0] ?? "?").toUpperCase();
  let h = 0;
  for (const c of symbol) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `<span class="cb-avatar cb-tone${h % AVATAR_TONES}" aria-hidden="true">${esc(letter)}</span>`;
}

const sharedChain = (items: ComboItem[]) => items.length > 0 && items.every((i) => i.chain === items[0].chain);

/** Filter and rank: exact symbol, then symbol prefix, then any other match; list order kept within each group. */
export function filterItems(items: ComboItem[], query: string): ComboItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  const ranked: ComboItem[][] = [[], [], []];
  for (const it of items) {
    const sym = it.symbol.toLowerCase();
    if (sym === q) ranked[0].push(it);
    else if (sym.startsWith(q)) ranked[1].push(it);
    else if (`${sym} ${it.chain ?? ""} ${it.keywords ?? ""}`.toLowerCase().includes(q)) ranked[2].push(it);
  }
  return ranked.flat();
}

/** Count line under the list. */
export function countText(shown: number, matches: number, total: number): string {
  if (matches > shown) return `Showing ${shown} of ${matches} matches. Keep typing to narrow the list.`;
  return `Showing ${shown} of ${total}`;
}

export function comboboxHtml(o: ComboOptions): string {
  const sel = o.items.find((i) => i.value === o.value);
  const tag = !sharedChain(o.items);
  const listId = `${o.id}-list`;
  return `<div class="cb${sel ? " has-value" : ""}${o.disabled ? " is-disabled" : ""}" data-cb="${esc(o.id)}">
<label for="${esc(o.id)}">${esc(o.label)}</label>
<div class="cb-field">
<span class="cb-lead">${sel ? avatarHtml(sel.symbol) : ""}</span>
<input id="${esc(o.id)}" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${esc(listId)}" autocomplete="off" autocapitalize="off" spellcheck="false"
 placeholder="${esc(o.placeholder ?? "Search token or chain")}" value="${esc(sel?.symbol ?? "")}" data-value="${esc(sel?.value ?? "")}"${sel?.chain && tag ? ` aria-describedby="${esc(o.id)}-chain"` : ""}${o.disabled ? " disabled" : ""}>
<span class="cb-tag cb-sel-tag" id="${esc(o.id)}-chain"${sel?.chain && tag ? "" : " hidden"}>${esc(sel?.chain ?? "")}</span>
<button type="button" class="cb-clear" aria-label="Clear ${esc(o.label)}"${sel && !o.disabled ? "" : " hidden"}><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>
<span class="cb-chev" aria-hidden="true"><svg viewBox="0 0 16 16" width="14" height="14"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
</div>
<div class="cb-pop" hidden><ul class="cb-list" role="listbox" id="${esc(listId)}" aria-label="${esc(o.label)}"></ul><p class="cb-empty" hidden></p><p class="cb-count" aria-live="polite"></p></div>
</div>`;
}

/** Bind behaviour to a combobox rendered by comboboxHtml() inside `scope`. */
export function wireCombobox(scope: ParentNode, o: ComboOptions): void {
  const root = scope.querySelector<HTMLElement>(`[data-cb="${CSS.escape(o.id)}"]`);
  if (!root) return;
  const input = root.querySelector<HTMLInputElement>("input")!;
  const field = root.querySelector<HTMLElement>(".cb-field")!;
  const pop = root.querySelector<HTMLElement>(".cb-pop")!;
  const list = root.querySelector<HTMLUListElement>(".cb-list")!;
  const empty = root.querySelector<HTMLElement>(".cb-empty")!;
  const count = root.querySelector<HTMLElement>(".cb-count")!;
  const clear = root.querySelector<HTMLButtonElement>(".cb-clear")!;
  const lead = root.querySelector<HTMLElement>(".cb-lead")!;
  const selTag = root.querySelector<HTMLElement>(".cb-sel-tag")!;
  const tag = !sharedChain(o.items);
  const selected = () => o.items.find((i) => i.value === o.value);

  let open = false;
  let typed = false;
  let shown: ComboItem[] = [];
  let active = -1;

  const optId = (i: number) => `${o.id}-opt-${i}`;
  const name = (it: ComboItem) => [it.symbol, tag ? it.chain : "", it.meta].filter(Boolean).join(", ");

  function render() {
    const matches = filterItems(o.items, typed ? input.value : "");
    shown = matches.slice(0, MAX_ROWS);
    list.innerHTML = shown
      .map(
        (it, i) => `<li role="option" id="${optId(i)}" aria-selected="${it.value === o.value}" aria-label="${esc(name(it))}" data-i="${i}">
${avatarHtml(it.symbol)}<span class="cb-main"><strong>${esc(it.symbol)}</strong>${tag && it.chain ? `<span class="cb-tag">${esc(it.chain)}</span>` : ""}</span>${it.meta ? `<span class="cb-meta">${esc(it.meta)}</span>` : ""}<svg class="cb-check" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></li>`,
      )
      .join("");
    list.hidden = shown.length === 0;
    empty.hidden = shown.length > 0;
    empty.textContent = shown.length ? "" : (o.emptyText ?? "No token matches") + (input.value.trim() && typed ? ` "${input.value.trim()}"` : "");
    count.textContent = shown.length ? countText(shown.length, matches.length, o.items.length) : "";
    setActive(Math.min(active, shown.length - 1));
  }

  function setActive(i: number, scroll = true) {
    active = i;
    list.querySelector(".is-active")?.classList.remove("is-active");
    const el = i >= 0 ? list.querySelector<HTMLElement>(`#${CSS.escape(optId(i))}`) : null;
    if (el) {
      el.classList.add("is-active");
      input.setAttribute("aria-activedescendant", el.id);
      if (scroll) el.scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  }

  /** Flip the popover above the field when there is not enough room below. */
  function place() {
    list.style.maxHeight = "";
    const r = field.getBoundingClientRect();
    const need = pop.scrollHeight + 8;
    const below = window.innerHeight - r.bottom;
    const up = below < need && r.top > below;
    // Shrink the list (never under ~3 rows) when even the roomier side cannot fit the full 320px.
    const room = (up ? r.top : below) - 8 - (pop.offsetHeight - list.offsetHeight);
    if (room < list.offsetHeight) list.style.maxHeight = `${Math.max(140, room)}px`;
    root!.classList.toggle("cb-up", up);
    // Above: anchor the popover's bottom edge 4px over the field (the label sits above the field inside root).
    pop.style.top = up ? "auto" : "";
    pop.style.bottom = up ? `${root!.clientHeight - field.offsetTop + 4}px` : "";
  }

  function onDocPointer(e: PointerEvent) {
    if (!root!.isConnected) return document.removeEventListener("pointerdown", onDocPointer, true);
    if (!root!.contains(e.target as Node)) close();
  }

  /** Open on the selected row, or on `fallback` when nothing is selected. */
  function show(fallback: "none" | "first" | "last" = "none") {
    if (open || o.disabled) return;
    open = true;
    root!.classList.add("is-open");
    input.setAttribute("aria-expanded", "true");
    pop.hidden = false;
    active = -1;
    render();
    const sel = shown.findIndex((i) => i.value === o.value);
    setActive(sel >= 0 ? sel : fallback === "first" ? 0 : fallback === "last" ? shown.length - 1 : -1);
    place();
    document.addEventListener("pointerdown", onDocPointer, true);
  }

  /** Close and put the committed selection back into the input. */
  function close() {
    document.removeEventListener("pointerdown", onDocPointer, true);
    if (!open) return syncDisplay();
    open = false;
    typed = false;
    root!.classList.remove("is-open", "cb-up");
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    pop.hidden = true;
    list.innerHTML = "";
    syncDisplay();
  }

  /** Show the committed choice as the chip: logo or letter, bold symbol, chain tag, clear button. */
  function syncDisplay() {
    const sel = selected();
    input.value = sel?.symbol ?? "";
    input.dataset.value = sel?.value ?? "";
    lead.innerHTML = sel ? avatarHtml(sel.symbol) : "";
    const showTag = !!(sel?.chain && tag);
    selTag.textContent = showTag ? sel!.chain! : "";
    selTag.hidden = !showTag;
    if (showTag) input.setAttribute("aria-describedby", selTag.id);
    else input.removeAttribute("aria-describedby");
    clear.hidden = !sel || !!o.disabled;
    root!.classList.toggle("has-value", !!sel);
    root!.classList.remove("is-typing");
  }

  function commit(value: string) {
    const changed = value !== o.value;
    o.value = value;
    close();
    if (!changed) return;
    o.onChange(value);
    // The view usually redraws on change; keep keyboard focus on the new combobox unless the view moved it.
    if (!input.isConnected && (!document.activeElement || document.activeElement === document.body)) document.getElementById(o.id)?.focus();
  }

  input.addEventListener("input", () => {
    typed = true;
    root.classList.toggle("is-typing", input.value !== (selected()?.symbol ?? ""));
    if (!open) show();
    active = 0;
    render();
    setActive(shown.length ? 0 : -1);
    place();
  });

  input.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    const last = shown.length - 1;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!open) show(e.altKey ? "none" : "first");
        else if (!e.altKey) setActive(Math.min(active + 1, last));
        break;
      case "ArrowUp":
        e.preventDefault();
        if (!open) show("last");
        else setActive(Math.max(active - 1, 0));
        break;
      case "Home":
      case "End":
        if (!open || !shown.length) return;
        e.preventDefault();
        setActive(e.key === "Home" ? 0 : last);
        break;
      case "PageDown":
      case "PageUp":
        if (!open || !shown.length) return;
        e.preventDefault();
        setActive(e.key === "PageDown" ? Math.min(active + 8, last) : Math.max(active - 8, 0));
        break;
      case "Enter":
        if (!open) return; // closed: Enter submits the form as usual
        e.preventDefault();
        if (active >= 0 && shown[active]) commit(shown[active].value);
        else close();
        break;
      case "Escape":
        if (!open && !typed) return;
        e.preventDefault();
        e.stopPropagation();
        close();
        break;
      case "Tab":
        close();
        break;
    }
  });

  // Click in the field opens; a click on the chevron while open closes. Clear has its own handler.
  field.addEventListener("click", (e) => {
    if (o.disabled || (e.target as Element).closest(".cb-clear")) return;
    if (open && (e.target as Element).closest(".cb-chev")) return close();
    if (document.activeElement !== input) input.focus();
    if (!open) {
      show();
      input.select();
    }
  });

  clear.addEventListener("click", () => {
    commit("");
    document.getElementById(o.id)?.focus();
  });

  // Keep focus in the input while the pointer works the list (option clicks, scrollbar drags).
  pop.addEventListener("mousedown", (e) => e.preventDefault());
  list.addEventListener("click", (e) => {
    const li = (e.target as Element).closest<HTMLElement>("[role=option]");
    if (li) commit(shown[Number(li.dataset.i)].value);
  });
  list.addEventListener("pointermove", (e) => {
    const li = (e.target as Element).closest<HTMLElement>("[role=option]");
    if (li && Number(li.dataset.i) !== active) setActive(Number(li.dataset.i), false);
  });

  root.addEventListener("focusout", (e) => {
    if (!root.contains(e.relatedTarget as Node | null)) close();
  });
}
