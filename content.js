(() => {
  const api = globalThis.chrome; // chrome.* (callback style) works in both Chrome and Firefox
  const HOST_ID = "ccws-bar-host";
  const CHORD_TIMEOUT_MS = 1500;

  let settings = CCWS_DEFAULTS;
  let shortcutMap = new Map(); // canonical sequence -> button
  let chordBuffer = [];
  let chordTimer = null;
  let host = null;
  let sending = false;
  let lastCard = null;

  // ---------- settings ----------

  function applySettings(s) {
    settings = s;
    shortcutMap = new Map();
    for (const b of s.buttons || []) {
      const seq = ccwsNormalizeShortcut(b.shortcut);
      if (seq && b.message) shortcutMap.set(seq, b);
    }
    if (host) renderButtons();
    schedule();
  }

  ccwsLoadSettings(api.storage).then(applySettings);
  api.storage.onChanged.addListener((_changes, area) => {
    if (area === "sync") ccwsLoadSettings(api.storage).then(applySettings);
  });

  const active = () => location.pathname.startsWith(settings.pathPrefix || "/");

  // ---------- locating the composer / send button ----------

  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 10) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  }

  function findComposer() {
    const sel = settings.composerSelector?.trim();
    const candidates = [
      ...document.querySelectorAll(
        sel || 'textarea, [contenteditable="true"], [contenteditable="plaintext-only"]'
      ),
    ].filter((el) => !el.closest(`#${HOST_ID}`) && visible(el));
    if (!candidates.length) return null;
    // Nested contenteditables: keep the outermost.
    const outer = candidates.filter((el) => !candidates.some((o) => o !== el && o.contains(el)));
    if (outer.includes(document.activeElement)) return document.activeElement;
    // The chat composer is the bottom-most editable on the page.
    return outer.reduce((a, b) =>
      b.getBoundingClientRect().bottom > a.getBoundingClientRect().bottom ? b : a
    );
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
      const btn = [...node.querySelectorAll("button")].find(
        (b) => !b.closest(`#${HOST_ID}`) && looksLikeSend(b)
      );
      if (btn) return btn;
    }
    return null;
  }

  // The element we put the bar in front of: the composer's form, or a few
  // levels up so we sit above the whole input box rather than inside it.
  function looksLikeCard(el) {
    const cs = getComputedStyle(el);
    const border =
      parseFloat(cs.borderTopWidth) > 0 && !/rgba\(.*,\s*0\)|transparent/.test(cs.borderTopColor);
    const shadow = cs.boxShadow && cs.boxShadow !== "none";
    const filled = parseFloat(cs.borderTopLeftRadius) > 0 && alpha(cs.backgroundColor) > 0;
    return border || shadow || filled;
  }

  function findAnchor(composer) {
    const sel = settings.anchorSelector?.trim();
    const custom = sel && document.querySelector(sel);
    if (custom) return custom;
    // The bordered/rounded box that visually holds the input; the bar goes
    // above it, outside it.
    let card = (lastCard = null);
    for (let n = composer.parentElement, i = 0; n && n !== document.body && i < 10; n = n.parentElement, i++) {
      if (looksLikeCard(n)) {
        card = lastCard = n;
        break;
      }
    }
    const form = composer.closest("form");
    if (card) return form && form !== card && form.contains(card) ? form : card;
    if (form) return form;
    let node = composer;
    for (let i = 0; i < 3 && node.parentElement && node.parentElement !== document.body; i++) {
      node = node.parentElement;
    }
    return node;
  }

  // ---------- theme (match the page, not the OS) ----------

  function parseRGB(c) {
    const m = c.match(/[\d.]+/g);
    return m ? m.map(Number) : [255, 255, 255, 1];
  }
  function alpha(c) {
    const v = parseRGB(c);
    return c === "transparent" ? 0 : v.length > 3 ? v[3] : 1;
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

  async function fire(button) {
    if (sending || !active()) return;
    const composer = findComposer();
    if (!composer) {
      flash("Couldn't find the message box");
      return;
    }
    sending = true;
    try {
      setComposerText(composer, button.message);
      if (settings.autoSubmit) await submit(composer);
      flash(`Sent: ${button.label || button.message}`);
    } finally {
      sending = false;
    }
  }

  // ---------- UI ----------

  // Colors/font are borrowed from the page at runtime (see adoptPageStyle);
  // the values here are only fallbacks.
  const STYLE = `
    :host { all: initial; display: block; margin: 0 0 12px; padding: 0; opacity: 1 !important;
      --fg: #29261b; --fg2: #73726c; --bgh: #ffffff; --b: rgba(0,0,0,.15);
      --font: ui-sans-serif, system-ui, -apple-system, sans-serif; }
    :host([data-theme=dark]) { --fg: #f5f4ee; --fg2: #a6a39a; --bgh: #30302e; --b: rgba(255,255,255,.12); }
    .bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
      font: 400 13px/1 var(--font); -webkit-font-smoothing: antialiased; }
    button { font: inherit; cursor: pointer; border-radius: 999px; padding: 7px 12px;
      border: 1px solid var(--b); background: transparent; color: var(--fg2);
      display: inline-flex; gap: 7px; align-items: center;
      transition: background .15s, color .15s, border-color .15s; }
    button:hover { background: var(--bgh); color: var(--fg); }
    button:active { transform: scale(.98); }
    button:focus-visible { outline: 2px solid var(--fg2); outline-offset: 1px; }
    kbd { font: 11px/1 var(--font); letter-spacing: .04em; opacity: .55; }
    .gear { padding: 5px; border-color: transparent; }
    .gear svg { width: 20px; height: 20px; display: block; }
    .toast { font-size: 12px; color: var(--fg2); margin-left: 4px; }
    :host(.inline) { margin: 0 auto 0 0; align-self: center; flex: 0 1 auto; min-width: 0; }
    :host(.floating) { position: fixed; right: 16px; bottom: 96px; z-index: 2147483647; margin: 0; }
  `;

  const GEAR_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>`;

  // Match the input box: its font, text color, border color and fill.
  function adoptPageStyle(composer, card) {
    const set = (k, v) => v && host.style.getPropertyValue(k) !== v && host.style.setProperty(k, v);
    const ccs = getComputedStyle(composer);
    set("--font", ccs.fontFamily);
    set("--fg", ccs.color);
    if (card) {
      const kcs = getComputedStyle(card);
      if (parseFloat(kcs.borderTopWidth) > 0 && alpha(kcs.borderTopColor) > 0) set("--b", kcs.borderTopColor);
      if (alpha(kcs.backgroundColor) > 0) set("--bgh", kcs.backgroundColor);
    }
  }

  const prettyShortcut = (s) =>
    ccwsNormalizeShortcut(s)
      .replace(/Meta/g, "⌘")
      .replace(/Ctrl/g, "⌃")
      .replace(/Alt/g, "⌥")
      .replace(/Shift/g, "⇧")
      .replace(/\+/g, "");

  function createHost() {
    host = document.createElement("div");
    host.id = HOST_ID;
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${STYLE}</style><div class="bar"></div>`;
    renderButtons();
  }

  function renderButtons() {
    const bar = host.shadowRoot.querySelector(".bar");
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
      el.title = `Send "${b.message}"${b.shortcut ? `  (${ccwsNormalizeShortcut(b.shortcut)})` : ""}`;
      el.append(b.label || b.message);
      if (b.shortcut) {
        const k = document.createElement("kbd");
        k.textContent = prettyShortcut(b.shortcut);
        el.append(k);
      }
      // mousedown keeps focus in the composer; click does the work.
      el.addEventListener("mousedown", (e) => e.preventDefault());
      el.addEventListener("click", () => fire(b));
      bar.append(el);
    }
    const toast = document.createElement("span");
    toast.className = "toast";
    bar.append(toast);
  }

  let toastTimer;
  function flash(msg) {
    const t = host?.shadowRoot.querySelector(".toast");
    if (!t) return;
    t.textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.textContent = ""), 2000);
  }

  // The row under the input box (model picker, mode, etc.). We sit at its
  // left end. Found geometrically: probe just below the card (where the model
  // picker is), then walk up to the first ancestor that spans most of the
  // card's width without containing the card itself.
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
          if (el === host || el.contains(card)) break;
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
      const kids = [...el.children].filter((k) => k !== host);
      if (kids.length !== 1 || !wide(kids[0])) return el;
      el = kids[0];
    }
  }

  let lastFooterLog = null;
  function place() {
    if (!active()) {
      host?.remove();
      return;
    }
    if (!host) createHost();
    const composer = findComposer();
    if (!composer) {
      host.remove();
      return;
    }
    const anchor = findAnchor(composer);
    host.dataset.theme = pageIsDark(anchor.parentElement || document.body) ? "dark" : "light";
    adoptPageStyle(composer, lastCard);
    const footer = settings.placement === "above" ? null : findFooter(lastCard);
    host.classList.toggle("inline", !!footer);
    if (footer !== lastFooterLog) {
      lastFooterLog = footer;
      console.debug("[claude-code-web-shortcuts] row below input:", footer, "card:", lastCard);
    }
    if (footer) {
      host.classList.remove("floating");
      if (footer.firstElementChild !== host) footer.insertBefore(host, footer.firstChild);
    } else if (anchor.parentElement && host.nextElementSibling !== anchor) {
      host.classList.remove("floating");
      anchor.parentElement.insertBefore(host, anchor);
    } else if (!anchor.parentElement && !host.isConnected) {
      host.classList.add("floating");
      document.body.append(host);
    }
  }

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      place();
    }, 150);
  }

  new MutationObserver((muts) => {
    // Ignore mutations caused by our own insertion.
    if (muts.every((m) => [...m.addedNodes, ...m.removedNodes].every((n) => n === host))) return;
    schedule();
  }).observe(document.documentElement, { childList: true, subtree: true });
  schedule();

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
      if (res.hit) {
        resetChord();
        fire(res.hit);
      } else {
        chordBuffer.push(combo);
        clearTimeout(chordTimer);
        chordTimer = setTimeout(resetChord, CHORD_TIMEOUT_MS);
        flash(`${chordBuffer.join(" ")} …`);
      }
    },
    true
  );
})();
