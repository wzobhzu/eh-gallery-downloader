// Background service worker: open the downloader tab (single gallery) and the
// bulk manager tab (reused/focused, queued URL passed via storage).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "openDownloader" && msg.url) {
    chrome.tabs.create({ url: chrome.runtime.getURL("src/download.html") + "#" + encodeURIComponent(msg.url) });
    sendResponse({ ok: true });
    return false;
  }
  if (msg && msg.type === "openManager") {
    const managerUrl = chrome.runtime.getURL("src/manager.html");
    const enqueue = async () => {
      if (msg.url) {
        const cur = (await chrome.storage.local.get("ehdl.inbox"))["ehdl.inbox"] || [];
        cur.push(msg.url);
        await chrome.storage.local.set({ "ehdl.inbox": cur });
      }
      const tabs = await chrome.tabs.query({ url: managerUrl + "*" });
      if (tabs[0]) chrome.tabs.update(tabs[0].id, { active: true });
      else chrome.tabs.create({ url: managerUrl });
    };
    enqueue().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
