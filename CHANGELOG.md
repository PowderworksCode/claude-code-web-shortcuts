# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.1.1] - 2026-11-15

### Added

- **"open all pr's" button** above the message box. It collects the GitHub pull request links in the last 10 messages, removes duplicates, and opens each in a new background tab next to the current one. The number of messages is a setting.
- **Version on the settings page,** shown next to the title.

### Changed

- **New default buttons,** each with a Ctrl+Alt shortcut:

  | Button | Sends | Shortcut |
  |---|---|---|
  | yes | Yes, continue | Ctrl+Alt+Y |
  | links | List of links to review | Ctrl+Alt+N |
  | rebase | Pull and rebase everything on main | Ctrl+Alt+P |
  | next? | What's next? | Ctrl+Alt+R |
  | explain | Explain that last part | Ctrl+Alt+E |
  | do all | Do everything you just suggested | Ctrl+Alt+D |
  | stack | Sounds good, stack pr's | Ctrl+Alt+K |
  | status? | status? | Ctrl+Alt+S |

  Existing installs keep their saved buttons. Use "Reset to defaults" to switch.
- **Bar stays in the model-picker row.** When space is tight, it first tightens the button spacing, then extends left past the input box. It drops to its own line only as a last resort, and the choice no longer flips back and forth.
- **"Sent" note floats** above the buttons, so it no longer shifts the row.
- **Things above the message box go above attached strips** such as the branch / "Create PR" bar, instead of between that strip and the input.
- **Version** bumped past 0.1.0, which addons.mozilla.org had already registered.

### Removed

- **Position setting.** The quick-reply buttons always sit below the message box.

### Fixed

- **Free space in the model row is measured from its visible content.** Before, claude.ai's empty spacer counted as taken, so the buttons never seemed to fit.
- **Button outlines stay visible in the new-session box,** where the box's own border color is too faint to borrow.

## [0.0.1] - 2026-11-13

First release.

### Added

- **Quick-reply buttons** for Claude Code on the web (`claude.ai/code`). Clicking a button replaces whatever is in the message box with that button's message and sends it immediately.
- **Default buttons:**

  | Button | Sends | Shortcut |
  |---|---|---|
  | yes | Yes, continue | Ctrl+Alt+Y |
  | no | No, stop | Ctrl+Alt+N |
  | pull | Pull and rebase everything on main | Ctrl+Alt+P |
  | replan | Replan | Ctrl+Alt+R |
  | explain | Explain that last part | Ctrl+Alt+E |
  | do all | Do everything you just suggested | Ctrl+Alt+D |

- **Keychords:** shortcuts match the physical key, so ⌥+letter works on macOS. Two-step chords such as `Ctrl+K Y` are supported.
- **Placement:** the buttons sit in the model-picker row under the message box, or on their own line just below it when the row is too narrow. An "above the message box" position is also available.
- **Multiple inputs:** every chat input on the page gets its own bar, including the thread side panel in projects. Keyboard shortcuts go to the focused input, or else the one used last.
- **Matches the page:** the buttons take the message box's font, text color and border, and follow claude.ai's own light or dark theme.
- **Settings page:**
  - add, remove, reorder and edit buttons
  - record shortcuts, with duplicate shortcuts flagged
  - toggle "send immediately"
  - choose the position
  - change the active path prefix
  - override the CSS selectors under Advanced

  Changes save automatically and sync with your browser profile.
- **Browsers:** Chrome and Firefox (140+) from one MV3 manifest. Declares no data collection.
- **Docs:** MIT license and privacy policy.

[0.1.1]: https://github.com/PowderworksCode/claude-code-web-shortcuts/releases/tag/v0.1.1
[0.0.1]: https://github.com/PowderworksCode/claude-code-web-shortcuts/releases/tag/v0.0.1
