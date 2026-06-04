// Background service worker. Sole job: open the downloader tab. The downloader
// page (an extension page with host_permissions) does all fetching itself, so
// no cross-origin relay is needed here.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "openDownloader" && msg.url) {
    const target = chrome.runtime.getURL("src/download.html") + "#" + encodeURIComponent(msg.url);
    chrome.tabs.create({ url: target });
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
