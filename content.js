(() => {
  const api = globalThis.chrome; // chrome.* (callback style) works in both Chrome and Firefox
  const HOST_ATTR = "data-ccws";
  const CHORD_TIMEOUT_MS = 1500;

  let settings = CCWS_DEFAULTS;
  let shortcutMap = new Map(); // canonical sequence -> button
  let chordBuffer = [];
  let chordTimer = null;
  let sending = false;
  let lastFocused = null; // composer the user last typed in
  const bars = new Map(); // composer element -> Bar

  const isOurs = (el) => !!el?.closest?.(`[${HOST_ATTR}]`);

  // ---------- settings ----------

  function applySettings(s) {
    settings = s;
    shortcutMap = new Map();
    for (const b of s.buttons || []) {
      const seq = ccwsNormalizeShortcut(b.shortcut);
      if (seq && b.message) shortcutMap.set(seq, b);
    }
    for (const bar of bars.values()) bar.render();
    schedule();
  }

  ccwsLoadSettings(api.storage).then(applySettings);
  api.storage.onChanged.addListener((_changes, area) => {
    if (area === "sync") ccwsLoadSettings(api.storage).then(applySettings);
  });

  const active = () => location.pathname.startsWith(settings.pathPrefix || "/");

  // ---------- locating composers / send buttons ----------

  function visible(el, minWidth = 40) {
    const r = el.getBoundingClientRect();
    if (r.width < minWidth || r.height < 10) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  }

  // Every chat input on the page (a project can show two side by side).
  function findComposers() {
    const sel = settings.composerSelector?.trim();
    const candidates = [
      ...document.querySelectorAll(
        sel || 'textarea, [contenteditable="true"], [contenteditable="plaintext-only"]'
      ),
    ].filter((el) => !isOurs(el) && visible(el, sel ? 40 : 200));
    // Nested contenteditables: keep the outermost.
    return candidates.filter((el) => !candidates.some((o) => o !== el && o.contains(el)));
  }

  function findSendButton(composer) {
    const sel = settings.sendSelector?.trim();
    if (sel) return document.querySelector(sel);
    const looksLikeSend = (b) => {
      const text = `${b.getAttribute("aria-label") || ""} ${b.title || ""} ${
        b.dataset.testid || ""
      }`.toLowerCase();
      return /send|submit/.test(text) || b.type === "submit";
    };
    let node = composer;
    for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
      const btn = [...node.querySelectorAll("button")].find((b) => !isOurs(b) && looksLikeSend(b));
      if (btn) return btn;
    }
    return null;
  }

  function looksLikeCard(el) {
    const cs = getComputedStyle(el);
    const border = parseFloat(cs.borderTopWidth) > 0 && alpha(cs.borderTopColor) > 0;
    const shadow = cs.boxShadow && cs.boxShadow !== "none";
    const filled = parseFloat(cs.borderTopLeftRadius) > 0 && alpha(cs.backgroundColor) > 0;
    return border || shadow || filled;
  }

  // The bordered/rounded box that visually holds the input.
  function findCard(composer) {
    for (let n = composer.parentElement, i = 0; n && n !== document.body && i < 10; n = n.parentElement, i++) {
      if (looksLikeCard(n)) return n;
    }
    return null;
  }

  // What the bar goes above in "above" mode (or as a fallback).
  function findAnchor(composer, card) {
    const sel = settings.anchorSelector?.trim();
    const custom = sel && document.querySelector(sel);
    if (custom) return custom;
    const form = composer.closest("form");
    if (card) return form && form !== card && form.contains(card) ? form : card;
    if (form) return form;
    let node = composer;
    for (let i = 0; i < 3 && node.parentElement && node.parentElement !== document.body; i++) {
      node = node.parentElement;
    }
    return node;
  }

  // The row under the input box (model picker, mode, etc.). Found
  // geometrically: probe just below the card's right side, then walk up to
  // the first ancestor that spans most of the card's width without
  // containing the card.
  function findFooter(card) {
    const sel = settings.footerSelector?.trim();
    if (sel) return document.querySelector(sel);
    if (!card) return null;
    const cb = card.getBoundingClientRect();
    const wide = (el) => el.getBoundingClientRect().width >= cb.width * 0.6;
    for (let y = cb.bottom + 4; y < cb.bottom + 72; y += 6) {
      for (const x of [cb.right - 24, cb.right - 90, cb.right - 180]) {
        let el = document.elementFromPoint(x, y);
        for (; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
          if (isOurs(el) || el.contains(card)) break;
          if (el.getBoundingClientRect().top < cb.bottom - 4) break;
          if (wide(el)) return drillToRow(el, wide);
        }
      }
    }
    return null;
  }

  // Step through single wide wrappers until we reach the horizontal flex row.
  function drillToRow(el, wide) {
    for (;;) {
      const cs = getComputedStyle(el);
      if (cs.display.includes("flex") && cs.flexDirection.startsWith("row")) return el;
      const kids = [...el.children].filter((k) => !isOurs(k));
      if (kids.length !== 1 || !wide(kids[0])) return el;
      el = kids[0];
    }
  }

  // A cached footer is kept as long as it still sits just under the card, so
  // transient overlays (tooltips, popovers) can't make the bar jump around.
  function footerStillValid(footer, card) {
    if (!footer?.isConnected || !card || footer.contains(card)) return false;
    const cb = card.getBoundingClientRect();
    const fb = footer.getBoundingClientRect();
    return fb.height > 0 && fb.top >= cb.bottom - 4 && fb.top < cb.bottom + 80;
  }

  // ---------- theme (match the page, not the OS) ----------

  function parseRGB(c) {
    const m = c.match(/[\d.]+/g);
    return m ? m.map(Number) : [255, 255, 255, 1];
  }
  function alpha(c) {
    if (!c || c === "transparent") return 0;
    const v = parseRGB(c);
    return v.length > 3 ? v[3] : 1;
  }
  function pageIsDark(from) {
    for (let n = from; n; n = n.parentElement) {
      const bg = getComputedStyle(n).backgroundColor;
      if (alpha(bg) > 0.5) {
        const [r, g, b] = parseRGB(bg);
        return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
      }
    }
    return matchMedia("(prefers-color-scheme: dark)").matches;
  }

  // ---------- writing + submitting ----------

  function setComposerText(el, text) {
    el.focus();
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      const proto = Object.getPrototypeOf(el);
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    // contenteditable (ProseMirror / Lexical / etc.): select everything and
    // insert via execCommand so the editor's own input handling sees it.
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    if (!document.execCommand("insertText", false, text)) {
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      el.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })
      );
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function submit(composer) {
    // Wait for the editor state to propagate and the send button to enable.
    for (let i = 0; i < 20; i++) {
      await sleep(50);
      const btn = findSendButton(composer);
      if (btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true") {
        btn.click();
        return true;
      }
    }
    const opts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    composer.dispatchEvent(new KeyboardEvent("keydown", opts));
    composer.dispatchEvent(new KeyboardEvent("keypress", opts));
    composer.dispatchEvent(new KeyboardEvent("keyup", opts));
    return false;
  }

  async function fire(button, bar) {
    if (sending || !active() || !bar?.composer.isConnected) return;
    sending = true;
    try {
      setComposerText(bar.composer, button.message);
      if (settings.autoSubmit) await submit(bar.composer);
      bar.flash(`Sent: ${button.label || button.message}`);
    } finally {
      sending = false;
    }
  }

  // ---------- UI ----------

  // Colors/font are borrowed from the page at runtime (see Bar.adoptPageStyle);
  // the values here are only fallbacks.
  const STYLE = `
    :host { all: initial; display: block; margin: 0 0 12px; padding: 0; opacity: 1 !important;
      --fg: #29261b; --fg2: #73726c; --bgh: #ffffff; --b: rgba(0,0,0,.15);
      --font: ui-sans-serif, system-ui, -apple-system, sans-serif; }
    :host([data-theme=dark]) { --fg: #f5f4ee; --fg2: #a6a39a; --bgh: #30302e; --b: rgba(255,255,255,.12); }
    .bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
      font: 400 13px/1 var(--font); -webkit-font-smoothing: antialiased; }
    button { flex: none; font: inherit; cursor: pointer; border-radius: 999px; padding: 7px 12px;
      border: 1px solid var(--b); background: transparent; color: var(--fg2);
      display: inline-flex; gap: 7px; align-items: center; white-space: nowrap;
      transition: background .15s, color .15s, border-color .15s; }
    button:hover { background: var(--bgh); color: var(--fg); }
    button:active { transform: scale(.98); }
    button:focus-visible { outline: 2px solid var(--fg2); outline-offset: 1px; }
    .gear { padding: 5px; border-color: transparent; }
    .gear svg { width: 20px; height: 20px; display: block; }
    .toast { font-size: 12px; color: var(--fg2); margin-left: 4px; white-space: nowrap; }
    :host(.inline) { margin: 0 auto 0 8px; align-self: center; flex: none; }
    :host(.inline.first) { margin-left: 0; }
    :host(.row) { margin: 8px 0 0; }
  `;

  const GEAR_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>`;

  const prettyShortcut = (s) =>
    ccwsNormalizeShortcut(s)
      .replace(/Meta/g, "⌘")
      .replace(/Ctrl/g, "⌃")
      .replace(/Alt/g, "⌥")
      .replace(/Shift/g, "⇧")
      .replace(/\+/g, "");

  const setClass = (el, cls, on) => el.classList.contains(cls) !== on && el.classList.toggle(cls, on);

  class Bar {
    constructor(composer) {
      this.composer = composer;
      this.footer = null;
      this.host = document.createElement("div");
      this.host.setAttribute(HOST_ATTR, "");
      const root = this.host.attachShadow({ mode: "open" });
      root.innerHTML = `<style>${STYLE}</style><div class="bar"></div>`;
      this.render();
    }

    render() {
      const bar = this.host.shadowRoot.querySelector(".bar");
      bar.textContent = "";
      const gear = document.createElement("button");
      gear.type = "button";
      gear.className = "gear";
      gear.title = "Configure shortcuts";
      gear.innerHTML = GEAR_SVG;
      gear.addEventListener("click", () => api.runtime.sendMessage({ type: "ccws-open-options" }));
      bar.append(gear);
      for (const b of settings.buttons || []) {
        if (!b.message) continue;
        const el = document.createElement("button");
        el.type = "button";
        el.title = `Send "${b.message}"${b.shortcut ? `  (${prettyShortcut(b.shortcut)})` : ""}`;
        el.append(b.label || b.message);
        // mousedown keeps focus in the composer; click does the work.
        el.addEventListener("mousedown", (e) => e.preventDefault());
        el.addEventListener("click", () => fire(b, this));
        bar.append(el);
      }
      const toast = document.createElement("span");
      toast.className = "toast";
      bar.append(toast);
    }

    flash(msg) {
      const t = this.host.shadowRoot.querySelector(".toast");
      t.textContent = msg;
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => (t.textContent = ""), 2000);
    }

    // Width the buttons need on one line (independent of where we are).
    naturalWidth() {
      const kids = [...this.host.shadowRoot.querySelector(".bar").children].filter(
        (k) => !k.classList.contains("toast")
      );
      return kids.reduce((w, k) => w + k.getBoundingClientRect().width, 0) + 6 * (kids.length - 1);
    }

    adoptPageStyle(card) {
      const h = this.host;
      const set = (k, v) => v && h.style.getPropertyValue(k) !== v && h.style.setProperty(k, v);
      const ccs = getComputedStyle(this.composer);
      set("--font", ccs.fontFamily);
      set("--fg", ccs.color);
      if (card) {
        const kcs = getComputedStyle(card);
        if (parseFloat(kcs.borderTopWidth) > 0 && alpha(kcs.borderTopColor) > 0) set("--b", kcs.borderTopColor);
        if (alpha(kcs.backgroundColor) > 0) set("--bgh", kcs.backgroundColor);
      }
    }

    // Moves the host only when it's not already where it should be, so a
    // settled page sees no DOM churn at all.
    place() {
      const h = this.host;
      const card = findCard(this.composer);
      const anchor = findAnchor(this.composer, card);
      const theme = pageIsDark(anchor.parentElement || document.body) ? "dark" : "light";
      if (h.dataset.theme !== theme) h.dataset.theme = theme;
      this.adoptPageStyle(card);

      let footer = null;
      if (settings.placement !== "above") {
        footer = footerStillValid(this.footer, card) ? this.footer : findFooter(card);
      }
      if (footer !== this.footer) {
        console.debug("[claude-code-web-shortcuts] row below input:", footer, "card:", card);
        this.footer = footer;
      }

      if (!footer) {
        setClass(h, "inline", false);
        setClass(h, "row", false);
        if (anchor.parentElement && h.nextElementSibling !== anchor) anchor.parentElement.insertBefore(h, anchor);
        return;
      }

      // Inline in the footer row if the buttons fit beside what's there;
      // otherwise on their own line right under it. Both measurements ignore
      // our own host, so the decision is stable and doesn't oscillate.
      if (!h.isConnected) footer.parentElement.insertBefore(h, footer.nextSibling);
      const fits = this.naturalWidth() + 16 <= freeSpace(footer);
      if (fits) {
        // Sit after the page's left-side controls (e.g. + and mic) and before
        // the right-side ones (model picker), pushing the latter right.
        const fb = footer.getBoundingClientRect();
        const mid = fb.left + fb.width / 2;
        const others = [...footer.children].filter((k) => k !== h && !isOurs(k));
        const ref = others.find((k) => k.getBoundingClientRect().left >= mid) || null;
        setClass(h, "row", false);
        setClass(h, "inline", true);
        setClass(h, "first", ref === others[0]);
        if (h.parentElement !== footer || h.nextElementSibling !== ref) footer.insertBefore(h, ref);
      } else {
        setClass(h, "inline", false);
        setClass(h, "first", false);
        setClass(h, "row", true);
        if (h.previousElementSibling !== footer) footer.parentElement.insertBefore(h, footer.nextSibling);
      }
    }

    remove() {
      this.host.remove();
    }
  }

  function freeSpace(footer) {
    const cs = getComputedStyle(footer);
    const gap = parseFloat(cs.columnGap) || 0;
    const others = [...footer.children].filter((k) => !isOurs(k) && k.getBoundingClientRect().width > 0);
    const used = others.reduce((w, k) => w + k.getBoundingClientRect().width, 0) + gap * others.length;
    return footer.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - used;
  }

  // ---------- placement loop ----------

  function placeAll() {
    if (!active()) {
      for (const bar of bars.values()) bar.remove();
      bars.clear();
      return;
    }
    const composers = findComposers();
    const current = new Set(composers);

    // Bars whose composer went away. If the app re-rendered the input, hand the
    // existing bar to the new composer rather than tearing it down and
    // building a new one (that swap is what reads as flicker).
    const orphans = [];
    for (const [composer, bar] of bars) {
      if (!current.has(composer)) {
        bars.delete(composer);
        orphans.push(bar);
      }
    }
    for (const composer of composers) {
      if (bars.has(composer)) continue;
      const bar = orphans.shift() || new Bar(composer);
      bar.composer = composer;
      bars.set(composer, bar);
    }
    for (const bar of orphans) bar.remove();
    for (const bar of bars.values()) bar.place();
  }

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      placeAll();
    }, 150);
  }

  new MutationObserver((muts) => {
    // Ignore mutations that are only us moving our own bars.
    const onlyOurs = muts.every((m) =>
      [...m.addedNodes, ...m.removedNodes].every((n) => n.nodeType === 1 && n.hasAttribute(HOST_ATTR))
    );
    if (!onlyOurs) schedule();
  }).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("resize", schedule);
  schedule();

  document.addEventListener(
    "focusin",
    (e) => {
      if (bars.has(e.target)) lastFocused = e.target;
      else for (const c of bars.keys()) if (c.contains(e.target)) lastFocused = c;
    },
    true
  );

  // Which input a keyboard shortcut goes to: the focused one, else the one
  // last typed in, else the bottom-right-most one.
  function targetBar() {
    for (const [c, bar] of bars) if (c === document.activeElement || c.contains(document.activeElement)) return bar;
    if (lastFocused && bars.has(lastFocused)) return bars.get(lastFocused);
    let best = null;
    for (const [c, bar] of bars) {
      const r = c.getBoundingClientRect();
      if (!best || r.bottom + r.right > best.score) best = { bar, score: r.bottom + r.right };
    }
    return best?.bar;
  }

  // ---------- keychords ----------

  function resetChord() {
    chordBuffer = [];
    clearTimeout(chordTimer);
  }

  window.addEventListener(
    "keydown",
    (e) => {
      if (!active() || e.isComposing || !shortcutMap.size) return;
      const combo = ccwsComboFromEvent(e);
      if (!combo) return;

      const tryMatch = (buf) => {
        const seq = buf.join(" ");
        const hit = shortcutMap.get(seq);
        if (hit) return { hit };
        for (const k of shortcutMap.keys()) if (k.startsWith(seq + " ")) return { prefix: true };
        return null;
      };

      let res = tryMatch([...chordBuffer, combo]);
      if (!res && chordBuffer.length) {
        resetChord();
        res = tryMatch([combo]);
      }
      if (!res) return resetChord();

      e.preventDefault();
      e.stopPropagation();
      const bar = targetBar();
      if (res.hit) {
        resetChord();
        fire(res.hit, bar);
      } else {
        chordBuffer.push(combo);
        clearTimeout(chordTimer);
        chordTimer = setTimeout(resetChord, CHORD_TIMEOUT_MS);
        bar?.flash(`${chordBuffer.join(" ")} …`);
      }
    },
    true
  );
})();
