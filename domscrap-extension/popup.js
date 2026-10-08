const readBtn = document.getElementById("read");
const downloadBtn = document.getElementById("download");
const statusEl = document.getElementById("status");

let result = null; // { markdown, title, count }

function setStatus(text) {
  statusEl.textContent = text;
}

// Progress updates sent by content.js while it works
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "PROGRESS") setStatus(msg.text);
});

readBtn.onclick = async () => {
  readBtn.disabled = true;
  downloadBtn.style.display = "none";
  result = null;
  setStatus("Starting...");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.url || !tab.url.startsWith("https://claude.ai/")) {
      setStatus("Open a chat on claude.ai first.");
      return;
    }

    const res = await chrome.tabs.sendMessage(tab.id, { type: "READ_CHAT" });

    if (!res || res.error) {
      setStatus("Error: " + ((res && res.error) || "no response from the page."));
      return;
    }

    result = res;
    setStatus("Done. " + res.count + " messages read.");
    downloadBtn.style.display = "block";
  } catch (e) {
    setStatus("Error: " + e.message + " (try reloading the Claude tab)");
  } finally {
    readBtn.disabled = false;
  }
};

downloadBtn.onclick = () => {
  if (!result) return;

  const safeTitle = (result.title || "claude-chat")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "claude-chat";
  const date = new Date().toISOString().slice(0, 10);

  const blob = new Blob([result.markdown], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = safeTitle + "-" + date + ".md";
  a.click();

  URL.revokeObjectURL(url);
};