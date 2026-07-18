// On a search/listing page (has table.itg), inject a button that sends the current
// search URL to the bulk manager tab.
(function () {
  "use strict";
  if (!document.querySelector("table.itg")) return;
  if (document.getElementById("ehdl-bulk")) return;
  const btn = document.createElement("button");
  btn.id = "ehdl-bulk";
  btn.textContent = "Add this search to bulk downloader";
  Object.assign(btn.style, { position: "fixed", right: "12px", bottom: "12px", zIndex: 99999, padding: "10px 14px", background: "#5c0d11", color: "#fff", border: "0", borderRadius: "6px", cursor: "pointer", fontWeight: "bold" });
  btn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "openManager", url: location.href }, () => void chrome.runtime.lastError);
  });
  document.body.appendChild(btn);
})();
