# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.1.1] - 2026-11-13

### Changed

- Version bumped from 0.0.1 so it's higher than 0.1.0, which addons.mozilla.org had already registered. No code changes.

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
