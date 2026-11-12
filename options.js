const api = globalThis.chrome; // chrome.* (callback style) works in both Chrome and Firefox
const $ = (id) => document.getElementById(id);
const FIELDS = ["placement", "pathPrefix", "composerSelector", "sendSelector", "anchorSelector", "footerSelector"];
let buttons = [];

const ICONS = {
  up: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10l4-4 4 4"/></svg>',
  down: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>',
  x: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
};
const GLYPH = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Meta: "⌘", Enter: "↵", Backspace: "⌫", Escape: "Esc",
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Slash: "/", Period: ".", Comma: ",",
  Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Minus: "-", Equal: "=", Backquote: "`" };

// ---------- saving ----------

let saveTimer;
function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 300);
}

function save() {
  const values = Object.fromEntries(FIELDS.map((f) => [f, $(f).value.trim()]));
  values.pathPrefix ||= "/";
  api.storage.sync.set(
    {
      ...values,
      autoSubmit: $("autoSubmit").checked,
      buttons: buttons
        .filter((b) => b.message.trim())
        .map((b) => ({ label: b.label.trim(), message: b.message.trim(), shortcut: b.shortcut })),
    },
    () => status(api.runtime.lastError ? `Couldn't save: ${api.runtime.lastError.message}` : "Saved")
  );
}

let statusTimer;
function status(msg) {
  const el = $("status");
  el.textContent = msg;
  el.classList.add("on");
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    el.classList.remove("on");
    el.textContent = "Changes save automatically.";
  }, 1800);
}

// ---------- rendering ----------

function renderShortcut(el, shortcut) {
  el.textContent = "";
  if (!shortcut) {
    const none = document.createElement("span");
    none.className = "none";
    none.textContent = "Add shortcut";
    el.append(none);
    return;
  }
  shortcut.split(" ").forEach((combo, i) => {
    if (i) {
      const t = document.createElement("span");
      t.className = "then";
      t.textContent = "then";
      el.append(t);
    }
    for (const part of combo.split("+")) {
      const k = document.createElement("kbd");
      k.textContent = GLYPH[part] || part;
      el.append(k);
    }
  });
}

function markDuplicates() {
  const counts = {};
  for (const b of buttons) if (b.shortcut) counts[b.shortcut] = (counts[b.shortcut] || 0) + 1;
  document.querySelectorAll(".item").forEach((row, i) => {
    const dup = !!buttons[i].shortcut && counts[buttons[i].shortcut] > 1;
    row.classList.toggle("dup", dup);
    row.querySelector(".shortcut").title = dup ? "Another button uses this shortcut" : "Click to record";
  });
}

function iconButton(cls, svg, title, onclick) {
  const b = document.createElement("button");
  b.className = `icon ${cls}`.trim();
  b.innerHTML = svg;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.onclick = onclick;
  return b;
}

function rowEl(b, i) {
  const row = document.createElement("div");
  row.className = "item";

  const move = (d) => () => {
    [buttons[i], buttons[i + d]] = [buttons[i + d], buttons[i]];
    render();
    queueSave();
  };
  const handle = document.createElement("div");
  handle.className = "handle";
  const up = iconButton("", ICONS.up, "Move up", move(-1));
  const down = iconButton("", ICONS.down, "Move down", move(1));
  up.disabled = i === 0;
  down.disabled = i === buttons.length - 1;
  handle.append(up, down);

  const field = (key, cls, placeholder) => {
    const el = document.createElement("input");
    el.type = "text";
    el.className = cls;
    el.value = b[key];
    el.placeholder = placeholder;
    el.oninput = () => {
      b[key] = el.value;
      queueSave();
    };
    return el;
  };

  const sc = document.createElement("button");
  sc.className = "shortcut";
  renderShortcut(sc, b.shortcut);
  sc.onclick = () => record(sc, b);

  const remove = iconButton("remove", ICONS.x, "Remove", () => {
    buttons.splice(i, 1);
    render();
    queueSave();
  });

  row.append(handle, field("label", "label", "Label"), field("message", "message", "Message to send"), sc, remove);
  return row;
}

function render() {
  const rows = $("rows");
  rows.textContent = "";
  buttons.forEach((b, i) => rows.append(rowEl(b, i)));
  markDuplicates();
}

// ---------- shortcut recording ----------

let stopRecording = null;
function record(el, b) {
  stopRecording?.(false);
  const combos = [];
  let timer;
  el.classList.add("rec");
  el.textContent = "Press keys…";

  const finish = (commit) => {
    window.removeEventListener("keydown", onKey, true);
    clearTimeout(timer);
    el.classList.remove("rec");
    stopRecording = null;
    if (commit) {
      b.shortcut = ccwsNormalizeShortcut(combos.join(" "));
      queueSave();
    }
    renderShortcut(el, b.shortcut);
    markDuplicates();
  };
  const onKey = (e) => {
    const combo = ccwsComboFromEvent(e);
    if (!combo) return;
    e.preventDefault();
    e.stopPropagation();
    if (!combos.length && combo === "Escape") return finish(false);
    if (!combos.length && (combo === "Backspace" || combo === "Delete")) return finish(true);
    combos.push(combo);
    renderShortcut(el, ccwsNormalizeShortcut(combos.join(" ")));
    clearTimeout(timer);
    timer = setTimeout(() => finish(true), 1200);
  };
  window.addEventListener("keydown", onKey, true);
  timer = setTimeout(() => finish(false), 6000);
  stopRecording = finish;
}

// ---------- init ----------

function fill(s) {
  buttons = s.buttons.map((b) => ({
    label: b.label || "",
    message: b.message || "",
    shortcut: ccwsNormalizeShortcut(b.shortcut),
  }));
  $("autoSubmit").checked = s.autoSubmit;
  for (const f of FIELDS) $(f).value = s[f] || "";
  render();
}

$("add").onclick = () => {
  buttons.push({ label: "", message: "", shortcut: "" });
  render();
  document.querySelector(".item:last-child .label").focus();
};
$("reset").onclick = () => {
  if (!confirm("Replace all buttons and settings with the defaults?")) return;
  fill(structuredClone(CCWS_DEFAULTS));
  save();
};
$("autoSubmit").onchange = queueSave;
for (const f of FIELDS) $(f).oninput = $(f).onchange = queueSave;

ccwsLoadSettings(api.storage).then(fill);
