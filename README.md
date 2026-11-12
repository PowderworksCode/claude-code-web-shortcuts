# Claude Code Web Shortcuts

A Chrome/Firefox extension that adds one-click quick replies to Claude Code on the web (`claude.ai/code`).

The buttons sit under the message box, on the same line as the model picker:

![Buttons under the Claude Code message box, beside the model picker](docs/screenshot.png)

Clicking a button, or pressing its keychord, replaces whatever is in the message box with that button's message and sends it immediately. The buttons pick up the page's font and colors, so they match light and dark mode.

## Defaults

| Button | Sends | Shortcut |
|---|---|---|
| yes | Yes, continue | Ctrl+Alt+Y |
| no | No, stop | Ctrl+Alt+N |
| pull | Pull and rebase everything on main | Ctrl+Alt+P |
| replan | Replan | Ctrl+Alt+R |
| do all | Do everything you just suggested | Ctrl+Alt+D |

On macOS, Ctrl+Alt is ⌃⌥. Shortcuts match the physical key, so ⌥+letter works even though macOS would normally type a special character.

## Install

**Chrome:** open `chrome://extensions`, turn on Developer mode, click "Load unpacked" and choose this folder.

**Firefox:** open `about:debugging#/runtime/this-firefox`, click "Load Temporary Add-on…" and choose `manifest.json`. Temporary add-ons are removed when Firefox restarts. To keep it installed, sign it through addons.mozilla.org (unlisted is fine). `./package.sh` builds the zip to upload.

## Settings

Open settings with the ⚙ at the start of the button row, or the extension's toolbar icon. You can:

- **Buttons:** add, remove, reorder and edit buttons (label, message, shortcut).
- **Shortcuts:** click a shortcut to record a new one. Two steps make a chord: `Ctrl+K Y` means press Ctrl+K, then Y within 1.5s. Esc cancels; Backspace clears. A shortcut used by two buttons is outlined in red.
- **Send immediately:** turn this off and buttons only fill in the message box.
- **Position:** "Below, beside the model picker" (default) or "Above the message box".
- **Active on paths starting with:** defaults to `/code`.
- **Advanced:** CSS selector overrides for the message box, the send button, the row below the box, and the element to sit above. Use these if a claude.ai redesign breaks auto-detection.

Changes save automatically to `storage.sync`, so they follow your browser profile.

## License

MIT. See [LICENSE](LICENSE).
