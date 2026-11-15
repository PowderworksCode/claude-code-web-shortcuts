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

  // What the "Open PRs" button goes above.
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

  // Things attached on top of the input box (e.g. the branch / "Create PR"
  // strip) belong with it, so "above" means above all of them, not wedged in
  // between. A previous sibling counts as attached when it sits flush on top
  // and is about as wide.
  function extendOverAttached(anchor) {
    for (;;) {
      let prev = anchor.previousElementSibling;
      let ours = 0; // height of our own bar if it's currently wedged in between
      while (prev && isOurs(prev)) {
        const cs = getComputedStyle(prev);
        ours += prev.getBoundingClientRect().height + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom);
        prev = prev.previousElementSibling;
      }
      if (!prev) return anchor;
      const a = anchor.getBoundingClientRect();
      const p = prev.getBoundingClientRect();
      const gap = a.top - p.bottom - ours;
      const flush = p.height > 0 && gap >= -2 && gap <= 20;
      const sameWidth = Math.abs(p.width - a.width) <= a.width * 0.1;
      if (!flush || !sameWidth) return anchor;
      anchor = prev;
    }
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

  // ---------- GitHub PR links in recent messages ----------

  // claude.ai writes PR chips as .../issues/N links; GitHub redirects those to
  // the PR, so both forms count. The same number under either is one item.
  const PR_RE = /https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)/gi;

  const scrollable = (el) => {
    const oy = getComputedStyle(el).overflowY;
    return (oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 4;
  };

  // The scrolling transcript that belongs to this input: the biggest
  // scrollable box above it that overlaps it horizontally, searched from the
  // input outward so a project's side panel finds its own conversation.
  function findTranscript(composer) {
    const cr = composer.getBoundingClientRect();
    for (let n = composer.parentElement; n && n !== document.documentElement; n = n.parentElement) {
      let best = null;
      for (const el of n.querySelectorAll("*")) {
        if (isOurs(el) || el.contains(composer) || !scrollable(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.top >= cr.top || r.right <= cr.left || r.left >= cr.right) continue;
        if (!best || r.height * r.width > best.area) best = { el, area: r.height * r.width };
      }
      if (best) return best.el;
    }
    return null;
  }

  // The element whose children are the individual messages: step down
  // through wrappers while one child holds nearly all of the content.
  function findMessageList(scroller) {
    let el = scroller;
    for (let i = 0; i < 12; i++) {
      const kids = [...el.children].filter(
        (k) => !isOurs(k) && k.getAttribute("aria-hidden") !== "true" && k.getBoundingClientRect().height > 0
      );
      if (!kids.length) break;
      const total = el.scrollHeight || el.getBoundingClientRect().height;
      const big = kids.find((k) => k.scrollHeight >= total * 0.9);
      if (kids.length > 1 && !big) break;
      el = big || kids[0];
    }
    return el;
  }

  // The last `lookback` messages of this input's conversation. claude.ai
  // marks each one as data-testid="transcript-row" (rendered virtually, with
  // spacer divs standing in for off-screen rows); the structural guess is
  // only a fallback in case that attribute goes away.
  function recentMessages(composer, lookback) {
    const scroller = findTranscript(composer);
    for (const scope of [scroller, document].filter(Boolean)) {
      const rows = [...scope.querySelectorAll('[data-testid="transcript-row"]')];
      if (!rows.length) continue;
      const idx = (r) => Number(r.dataset.index ?? r.dataset.rsIndex);
      if (rows.every((r) => Number.isFinite(idx(r)))) rows.sort((x, y) => idx(x) - idx(y));
      return rows.slice(-lookback);
    }
    if (!scroller) return [document.body];
    const list = findMessageList(scroller);
    const kids = [...list.children].filter(
      (k) => !isOurs(k) && k.getAttribute("aria-hidden") !== "true" && k.textContent.trim()
    );
    return kids.length > 1 ? kids.slice(-lookback) : [list];
  }

  // Canonical PR URLs, newest messages only, deduped, in reading order.
  function recentPrLinks(composer, lookback) {
    const messages = recentMessages(composer, lookback);
    const seen = new Set();
    const urls = [];
    const add = (raw) => {
      for (const m of raw.matchAll(PR_RE)) {
        const url = `https://github.com/${m[1]}/${m[2]}/${m[3].toLowerCase()}/${m[4]}`;
        const key = `${m[1]}/${m[2]}#${m[4]}`.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          urls.push(url);
        }
      }
    };
    for (const msg of messages) {
      // Links, plus any attribute that carries a URL (data-href, title, ...),
      // since PR chips aren't always plain <a> tags.
      for (const el of msg.querySelectorAll("*")) {
        if (isOurs(el)) continue;
        if (el.href) add(String(el.href));
        for (const at of el.attributes) if (at.value.includes("github.com")) add(at.value);
      }
      add(msg.innerText || msg.textContent || "");
    }
    console.debug("[claude-code-web-shortcuts] open PRs", { messages, urls });
    return urls;
  }

  function openPrs(bar) {
    const lookback = Math.max(1, parseInt(settings.prLookback, 10) || 10);
    const urls = recentPrLinks(bar.composer, lookback);
    if (!urls.length) return bar.flashTop(`No PR links in the last ${lookback} messages`);
    api.runtime.sendMessage({ type: "ccws-open-tabs", urls });
    bar.flashTop(`Opened ${urls.length} PR${urls.length === 1 ? "" : "s"}`);
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
    :host { all: initial; display: block; margin: 8px 0 10px; padding: 0; opacity: 1 !important;
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
    .bar { position: relative; }
    .toast { position: absolute; left: 0; bottom: calc(100% + 4px); pointer-events: none;
      font-size: 12px; color: var(--fg2); white-space: nowrap; }
    .toast:empty { display: none; }
    :host(.inline) { margin: 0 auto 0 8px; align-self: center; flex: none; }
    :host(.inline.first) { margin-left: 0; }
    :host(.inline) .bar { flex-wrap: nowrap; }
    :host(.compact) .bar { gap: 4px; }
    :host(.compact) button:not(.gear) { padding-left: 9px; padding-right: 9px; }
    :host(.row) { margin: 8px 0 0; }
    :host(.top) { margin: 0 0 12px; }
    :host(.top) .toast { position: static; margin-left: 4px; }
    .pr svg { width: 14px; height: 14px; display: block; }
  `;

  const GEAR_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>`;

  const PR_SVG = `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"/></svg>`;

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

      // "Open PRs" lives in its own small bar above the input box.
      this.top = document.createElement("div");
      this.top.setAttribute(HOST_ATTR, "");
      this.top.className = "top";
      const troot = this.top.attachShadow({ mode: "open" });
      troot.innerHTML = `<style>${STYLE}</style><div class="bar"></div>`;
      const pr = document.createElement("button");
      pr.type = "button";
      pr.className = "pr";
      pr.innerHTML = PR_SVG;
      pr.append("open all pr's");
      pr.addEventListener("mousedown", (e) => e.preventDefault());
      pr.addEventListener("click", () => openPrs(this));
      const ttoast = document.createElement("span");
      ttoast.className = "toast";
      troot.querySelector(".bar").append(pr, ttoast);
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

    flashTop(msg) {
      const t = this.top.shadowRoot.querySelector(".toast");
      t.textContent = msg;
      clearTimeout(this.topTimer);
      this.topTimer = setTimeout(() => (t.textContent = ""), 3000);
    }

    // Width the buttons need on one line (independent of where we are).
    // Widths the bar needs on one line, in normal and compact spacing.
    // Derived from the current layout either way, so measuring never needs
    // a class toggle (which would itself cause a reflow / flicker).
    widths() {
      const kids = [...this.host.shadowRoot.querySelector(".bar").children].filter(
        (k) => !k.classList.contains("toast")
      );
      const compact = this.host.classList.contains("compact");
      const gap = compact ? 4 : 6;
      const measured = kids.reduce((w, k) => w + k.getBoundingClientRect().width, 0) + gap * (kids.length - 1);
      const buttons = kids.filter((k) => !k.classList.contains("gear")).length;
      const saving = buttons * 6 + 2 * (kids.length - 1); // 3px less padding a side, 2px less gap
      return compact ? { normal: measured + saving, compact: measured } : { normal: measured, compact: measured - saving };
    }

    adoptPageStyle(card) {
      const set = (k, v) => {
        for (const h of [this.host, this.top]) if (v && h.style.getPropertyValue(k) !== v) h.style.setProperty(k, v);
      };
      const ccs = getComputedStyle(this.composer);
      set("--font", ccs.fontFamily);
      set("--fg", ccs.color);
      if (card) {
        const kcs = getComputedStyle(card);
        // Borrow the box's border only when it's a plain, visible rgb color;
        // a faint or oklch/color() border (the new-session box) made the
        // pills look borderless, so fall back to our own outline instead.
        const bc = kcs.borderTopColor;
        const usable = parseFloat(kcs.borderTopWidth) > 0 && /^rgba?\(/.test(bc) && alpha(bc) >= 0.08;
        if (usable) set("--b", bc);
        else for (const h of [this.host, this.top]) h.style.removeProperty("--b");
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
      for (const el of [h, this.top]) if (el.dataset.theme !== theme) el.dataset.theme = theme;
      this.adoptPageStyle(card);

      // "Open PRs" goes above the input box and anything attached on top of it.
      const top = extendOverAttached(anchor);
      if (top.parentElement && this.top.nextElementSibling !== top) top.parentElement.insertBefore(this.top, top);

      const footer = footerStillValid(this.footer, card) ? this.footer : findFooter(card);
      if (footer !== this.footer) {
        console.debug("[claude-code-web-shortcuts] row below input:", footer, "card:", card);
        this.footer = footer;
      }

      // No row under the box: sit on our own line just below it.
      if (!footer) {
        setClass(h, "inline", false);
        setClass(h, "row", true);
        h.style.marginLeft = "";
        const below = card || anchor;
        if (below.parentElement && h.previousElementSibling !== below) below.parentElement.insertBefore(h, below.nextSibling);
        return;
      }

      // Inline in the footer row if the buttons fit beside what's there;
      // otherwise on their own line right under it. Both measurements ignore
      // our own host, so the decision is stable and doesn't oscillate.
      if (!h.isConnected) footer.parentElement.insertBefore(h, footer.nextSibling);
      // Layouts in order of preference, picked from measurements that ignore
      // our own bar, so the choice is stable:
      //  1. inline in the row, after the left-side controls (e.g. + and mic)
      //     and before the right-side ones (model picker)
      //  2. same, with tighter button padding
      //  3. tight, as the row's first item, extending left past the input
      //     box's edge into empty page
      //  4. on its own line under the row
      const free = freeSpace(footer) - 8;
      const { normal, compact } = this.widths();
      const fb = footer.getBoundingClientRect();
      const roomLeft = fb.left - 8;
      const others = [...footer.children].filter((k) => k !== h && !isOurs(k));
      const margin = (px) => {
        const v = px ? `${px}px` : "";
        if (h.style.marginLeft !== v) h.style.marginLeft = v;
      };
      let mode;
      if (normal <= free) mode = "fit";
      else if (compact <= free) mode = "compact";
      else if (compact - free <= roomLeft) mode = "extend";
      else mode = "row";
      if (mode !== this.mode) {
        this.mode = mode;
        console.debug("[claude-code-web-shortcuts] layout", { mode, free, normal, compact, roomLeft, footer });
      }

      setClass(h, "compact", mode === "compact" || mode === "extend");
      if (mode === "row") {
        setClass(h, "inline", false);
        setClass(h, "first", false);
        setClass(h, "row", true);
        margin(0);
        if (h.previousElementSibling !== footer) footer.parentElement.insertBefore(h, footer.nextSibling);
        return;
      }
      const mid = fb.left + fb.width / 2;
      const ref =
        mode === "extend" ? others[0] || null : others.find((k) => k.getBoundingClientRect().left >= mid) || null;
      setClass(h, "row", false);
      setClass(h, "inline", true);
      setClass(h, "first", ref === others[0]);
      margin(mode === "extend" ? -Math.ceil(compact - free) : 0);
      if (h.parentElement !== footer || h.nextElementSibling !== ref) footer.insertBefore(h, ref);
    }

    remove() {
      this.host.remove();
      this.top.remove();
    }
  }

  // Horizontal extent of what's actually visible inside el (text, icons,
  // controls), ignoring empty boxes that only stretch to fill space. Returns
  // [left, right] or null when nothing is visible.
  function visibleExtent(el, depth = 0) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.opacity === "0") return null;
    const solid =
      /^(BUTTON|SVG|IMG|INPUT|SELECT|svg)$/.test(el.tagName) ||
      alpha(cs.backgroundColor) > 0 ||
      parseFloat(cs.borderLeftWidth) > 0;
    const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (solid || ownText || depth > 6) return [r.left, r.right];
    let ext = null;
    for (const k of el.children) {
      const e = visibleExtent(k, depth + 1);
      if (e) ext = ext ? [Math.min(ext[0], e[0]), Math.max(ext[1], e[1])] : e;
    }
    return ext;
  }

  // Width in the row not taken by the page's own visible controls.
  function freeSpace(footer) {
    const cs = getComputedStyle(footer);
    const gap = parseFloat(cs.columnGap) || 0;
    let used = 0;
    let count = 0;
    for (const k of footer.children) {
      if (isOurs(k)) continue;
      const e = visibleExtent(k);
      if (!e) continue;
      used += e[1] - e[0];
      count++;
    }
    return footer.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - used - gap * count;
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
