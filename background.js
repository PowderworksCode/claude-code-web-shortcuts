// Toolbar icon and the in-page ⚙ button both open the settings page.
const api = globalThis.chrome; // chrome.* (callback style) works in both Chrome and Firefox
api.action.onClicked.addListener(() => api.runtime.openOptionsPage());
api.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "ccws-open-options") api.runtime.openOptionsPage();
});
