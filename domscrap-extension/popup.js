const readBtn = document.getElementById("read");
const downloadBtn = document.getElementById("download");
const statusEl = document.getElementById("status");

// Sites the extension can read. Keep this in step with manifest.json.
const SUPPORTED_HOSTS = [
  "claude.ai",
  "chatgpt.com",
  "chat.openai.com",
  "gemini.google.com",
];

// Two extra elements are created here, so popup.html does not change.
const warnEl = document.createElement("div");
warnEl.style.cssText =
  "display:none;margin:8px 0;padding:8px;border:1px solid #d98e04;" +
  "background:#fff6e0;color:#5c3d00;font-size:12px;white-space:pre-wrap;";
statusEl.after(warnEl);

const debugBtn = document.createElement("button");
debugBtn.textContent = "Copy debug info";
debugBtn.style.display = "none";
warnEl.after(debugBtn);

let result = null;     // { markdown, title, count, warnings, method, debug, site }
let debugText = "";    // what the debug button copies (never contains chat text)

function setStatus(text) {
  statusEl.textContent = text;
}

function showWarnings(list) {
  if (list && list.length) {
    warnEl.textContent =
      "Check this capture:\n" + list.map((w) => "• " + w).join("\n");
    warnEl.style.display = "block";
  } else {
    warnEl.style.display = "none";
    warnEl.textContent = "";
  }
}

function setDebug(text) {
  debugText = text;
  debugBtn.style.display = text ? "block" : "none";
}

function isSupported(url) {
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" &&
      SUPPORTED_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith("." + h))
    );
  } catch (e) {
    return false;
  }
}

// Progress updates sent by content.js while it works
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "PROGRESS") setStatus(msg.text);
});

readBtn.onclick = async () => {
  readBtn.disabled = true;
  downloadBtn.style.display = "none";
  showWarnings(null);
  setDebug("");
  result = null;
  setStatus("Starting...");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.url || !isSupported(tab.url)) {
      setStatus("Open a chat on Claude, ChatGPT or Gemini first.");
      return;
    }

    const res = await chrome.tabs.sendMessage(tab.id, { type: "READ_CHAT" });

    if (!res || res.error) {
      const err = (res && res.error) || "no response from the page.";
      setStatus("Capture failed. The page may have changed, or this site is not set up yet.");
      showWarnings([err]);
      setDebug("DomScrap capture FAILED\nurl host: " + new URL(tab.url).hostname + "\n" + err);
      return;
    }

    result = res;
    const warnings = res.warnings || [];
    const site = res.site || "chat";

    if (warnings.length) {
      setStatus("Done with warnings. " + res.count + " messages read from " + site + ". Check before using.");
    } else {
      setStatus("Done. " + res.count + " messages read from " + site + ".");
    }
    showWarnings(warnings);

    setDebug(
      "DomScrap debug (no chat text)\n" +
      "method: " + res.method + "\n" +
      "warnings: " + (warnings.length ? warnings.join(" | ") : "none") + "\n" +
      res.debug
    );
    downloadBtn.style.display = "block";
  } catch (e) {
    setStatus("Error: " + e.message + " (reload the chat tab and try again)");
    setDebug("DomScrap error\n" + e.message);
  } finally {
    readBtn.disabled = false;
  }
};

debugBtn.onclick = async () => {
  try {
    await navigator.clipboard.writeText(debugText);
    debugBtn.textContent = "Copied. Paste it in the chat.";
  } catch (e) {
    debugBtn.textContent = "Copy failed";
  }
  setTimeout(() => (debugBtn.textContent = "Copy debug info"), 2500);
};

downloadBtn.onclick = () => {
  if (!result) return;

  const safeTitle = (result.title || "ai-chat")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "ai-chat";
  const date = new Date().toISOString().slice(0, 10);

  const blob = new Blob([result.markdown], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = safeTitle + "-" + date + ".md";
  a.click();

  URL.revokeObjectURL(url);
};