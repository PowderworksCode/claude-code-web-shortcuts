// Toolbar icon and the in-page ⚙ button both open the settings page.
const api = globalThis.chrome; // chrome.* (callback style) works in both Chrome and Firefox
api.action.onClicked.addListener(() => api.runtime.openOptionsPage());
api.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === "ccws-open-options") api.runtime.openOptionsPage();
  // "Open PRs": open each URL as a background tab right after the current one.
  // Done here because a page can only open one popup per click.
  if (msg?.type === "ccws-open-tabs" && Array.isArray(msg.urls)) {
    const tab = sender.tab;
    msg.urls
      .filter((u) => /^https:\/\/github\.com\/[^/]+\/[^/]+\/(pull|issues)\/\d+$/.test(u))
      .forEach((url, i) =>
        api.tabs.create({
          url,
          active: false,
          ...(tab ? { index: tab.index + 1 + i, openerTabId: tab.id, windowId: tab.windowId } : {}),
        })
      );
  }
});
