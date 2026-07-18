// Popup: open the downloader tab for the current page, or for a pasted URL.
// All work happens in the downloader tab, so the popup just hands off a URL.

const PAGE_RE = /^https?:\/\/(?:e-hentai|exhentai)\.org\/(?:g|s)\//;

function $(id) { return document.getElementById(id); }

function openDownloader(url) {
  chrome.runtime.sendMessage({ type: "openDownloader", url }, () => {
    void chrome.runtime.lastError;
    window.close();
  });
}

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  const url = tab && tab.url ? tab.url : "";
  if (PAGE_RE.test(url)) {
    $("on-page").hidden = false;
    $("paste").hidden = true;
    $("start").addEventListener("click", () => openDownloader(url));
  }
});

$("open").addEventListener("click", () => {
  const raw = $("url").value.trim();
  if (!PAGE_RE.test(raw)) {
    $("hint").textContent = "Invalid URL. Expected a /g/ or /s/ URL on e-hentai.org or exhentai.org.";
    $("hint").className = "err";
    return;
  }
  openDownloader(raw);
});

document.getElementById("bulk").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "openManager" }, () => { void chrome.runtime.lastError; window.close(); });
});
