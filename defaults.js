// Shared between the content script and the options page.
// Shortcut format: one or more combos separated by spaces, e.g. "Ctrl+Alt+Y"
// or a two-step chord like "Ctrl+K Y". Modifiers: Ctrl, Alt, Shift, Meta (Cmd).
// Keys are named by physical key (KeyY -> "Y", Digit1 -> "1", others by code,
// e.g. "Slash", "Enter", "F2"), so Option-letter on macOS still matches.

var CCWS_DEFAULTS = {
  autoSubmit: true,
  placement: "below",
  footerSelector: "",
  pathPrefix: "/code",
  composerSelector: "",
  sendSelector: "",
  anchorSelector: "",
  buttons: [
    { label: "yes", message: "Yes, continue", shortcut: "Ctrl+Alt+Y" },
    { label: "no", message: "No, stop", shortcut: "Ctrl+Alt+N" },
    {
      label: "pull",
      message: "Pull and rebase everything on main",
      shortcut: "Ctrl+Alt+P",
    },
    { label: "replan", message: "Replan", shortcut: "Ctrl+Alt+R" },
    {
      label: "do all",
      message: "Do everything you just suggested",
      shortcut: "Ctrl+Alt+D",
    },
  ],
};

var CCWS_MODS = ["Ctrl", "Alt", "Shift", "Meta"];
var CCWS_ALIASES = {
  control: "Ctrl", ctrl: "Ctrl",
  alt: "Alt", option: "Alt", opt: "Alt",
  shift: "Shift",
  meta: "Meta", cmd: "Meta", command: "Meta", super: "Meta", win: "Meta",
};

function ccwsKeyName(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  return code;
}

// KeyboardEvent -> canonical combo string, or null for bare modifier presses.
function ccwsComboFromEvent(e) {
  if (/^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/.test(e.code) || !e.code) return null;
  const parts = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Meta");
  parts.push(ccwsKeyName(e.code));
  return parts.join("+");
}

// User-typed shortcut -> canonical form ("alt+ctrl+y  k" -> "Ctrl+Alt+Y K").
function ccwsNormalizeShortcut(str) {
  if (!str) return "";
  return str
    .trim()
    .split(/\s+/)
    .map((combo) => {
      const tokens = combo.split("+").filter(Boolean);
      const mods = new Set();
      let key = "";
      for (const t of tokens) {
        const alias = CCWS_ALIASES[t.toLowerCase()];
        if (alias) mods.add(alias);
        else key = t.length === 1 ? t.toUpperCase() : t[0].toUpperCase() + t.slice(1);
      }
      return [...CCWS_MODS.filter((m) => mods.has(m)), key].filter(Boolean).join("+");
    })
    .filter(Boolean)
    .join(" ");
}

function ccwsLoadSettings(storage) {
  return new Promise((resolve) => {
    storage.sync.get(CCWS_DEFAULTS, (s) => resolve(Object.assign({}, CCWS_DEFAULTS, s)));
  });
}
