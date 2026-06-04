// Content script for /g (gallery) and /s (image) pages. Intentionally tiny:
// it only injects a trigger button. All the heavy lifting (scraping, fetching,
// zipping) happens in a dedicated downloader tab that survives navigation, so
// nothing stateful lives in this page context.

(function () {
  "use strict";

  if (!/^\/(g|s)\//.test(location.pathname)) return;

  const btn = document.createElement("button");
  btn.id = "ehdl-trigger";
  btn.textContent = "Download gallery as ZIP";
  btn.title = "Open the downloader for this gallery in a new tab";
  btn.addEventListener("click", () => {
    btn.disabled = true;
    btn.textContent = "Opening downloader…";
    chrome.runtime.sendMessage({ type: "openDownloader", url: location.href }, () => {
      void chrome.runtime.lastError; // background owns the rest
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = "Download gallery as ZIP";
      }, 1500);
    });
  });

  const mount = () => document.body && document.body.appendChild(btn);
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
})();
