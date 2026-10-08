// Runs inside the claude.ai page. Uses SELECTORS from selectors.js.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function progress(text) {
  try {
    chrome.runtime.sendMessage({ type: "PROGRESS", text }).catch(() => {});
  } catch (e) {}
}

// ---------- finding messages ----------

function pickAll(list) {
  for (const sel of list) {
    try {
      const nodes = Array.from(document.querySelectorAll(sel));
      if (nodes.length) return { selector: sel, nodes };
    } catch (e) {}
  }
  return { selector: null, nodes: [] };
}

let usedSelectors = { user: null, assistant: null };

function collectElements() {
  const u = pickAll(SELECTORS.userMessage);
  const a = pickAll(SELECTORS.assistantMessage);
  usedSelectors = { user: u.selector, assistant: a.selector };

  let items = [
    ...u.nodes.map((el) => ({ el, role: "user" })),
    ...a.nodes.map((el) => ({ el, role: "assistant" })),
  ];
  // drop elements nested inside another selected element
  items = items.filter((x) => !items.some((y) => y !== x && y.el.contains(x.el)));
  // page order
  items.sort((x, y) =>
    x.el.compareDocumentPosition(y.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
  );
  return items;
}

function findScroller(fromEl) {
  const custom = pickAll(SELECTORS.scroller).nodes[0];
  if (custom) return custom;
  for (let el = fromEl.parentElement; el && el !== document.body; el = el.parentElement) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 20) return el;
  }
  return document.scrollingElement;
}

// ---------- DOM -> markdown ----------

function isIgnored(el) {
  return SELECTORS.ignore.some((s) => {
    try { return el.matches(s); } catch (e) { return false; }
  });
}

function listMd(list, depth) {
  const ordered = list.tagName.toLowerCase() === "ol";
  const start = parseInt(list.getAttribute("start") || "1", 10);
  const lis = Array.from(list.children).filter((c) => c.tagName.toLowerCase() === "li");
  return lis
    .map((li, i) => {
      const prefix = ordered ? start + i + ". " : "- ";
      const indent = "  ".repeat(depth);
      const nested = [];
      const rest = [];
      Array.from(li.childNodes).forEach((n) => {
        const t = n.nodeType === 1 ? n.tagName.toLowerCase() : "";
        if (t === "ul" || t === "ol") nested.push(listMd(n, depth + 1));
        else rest.push(walk(n, depth));
      });
      const text = rest.join("").replace(/\s*\n\s*/g, " ").trim();
      return indent + prefix + text + (nested.length ? "\n" + nested.join("\n") : "");
    })
    .join("\n");
}

function tableMd(table) {
  const rows = Array.from(table.querySelectorAll("tr")).map((tr) =>
    Array.from(tr.children).map((c) =>
      walk(c, 0).replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim()
    )
  );
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r) => r.concat(Array(width - r.length).fill(""));
  const line = (r) => "| " + pad(r).join(" | ") + " |";
  const sep = "| " + Array(width).fill("---").join(" | ") + " |";
  return "\n\n" + [line(rows[0]), sep, ...rows.slice(1).map(line)].join("\n") + "\n\n";
}

function walk(node, depth = 0) {
  if (node.nodeType === 3) return node.textContent.replace(/\s+/g, " ");
  if (node.nodeType !== 1) return "";
  if (isIgnored(node)) return "";

  const tag = node.tagName.toLowerCase();
  const kids = () => Array.from(node.childNodes).map((n) => walk(n, depth)).join("");

  switch (tag) {
    case "br": return "\n";
    case "hr": return "\n\n---\n\n";
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
      const t = kids().trim();
      // screen-reader heading the page adds to every reply: drop it
      if (/^Claude responded:/i.test(t)) return "";
      return "\n\n" + "#".repeat(Number(tag[1])) + " " + t + "\n\n";
    }
    case "p": return "\n\n" + kids().trim() + "\n\n";
    case "strong": case "b": { const t = kids().trim(); return t ? "**" + t + "**" : ""; }
    case "em": case "i": { const t = kids().trim(); return t ? "*" + t + "*" : ""; }
    case "code": return "`" + node.textContent + "`";
    case "pre": {
      const code = node.querySelector("code");
      const text = (code || node).textContent.replace(/\n$/, "");
      const m = ((code && code.className) || "").match(/language-([\w+#-]+)/);
      const fence = text.includes("```") ? "````" : "```";
      return "\n\n" + fence + (m ? m[1] : "") + "\n" + text + "\n" + fence + "\n\n";
    }
    case "a": {
      const t = kids().trim();
      const href = node.getAttribute("href");
      return href && t ? "[" + t + "](" + href + ")" : t;
    }
    case "ul": case "ol": return "\n\n" + listMd(node, depth) + "\n\n";
    case "blockquote":
      return "\n\n" + kids().trim().split("\n").map((l) => "> " + l).join("\n") + "\n\n";
    case "table": return tableMd(node);
    case "div": case "section": case "article": return "\n" + kids() + "\n";
    default: return kids();
  }
}

// Lines that are page labels (tool chips), not message content.
const NOISE_EXACT = new Set([
  "Recalled memory",
  "Updated memory",
  "Used a tool",
  "Created a file",
]);
const NOISE_PATTERN = /^(Read|Ran|Searched|Viewed|Edited|Used) \d+ [a-z]+(, [a-z0-9 ]+)*$/i;

function stripNoise(s) {
  return s
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(NOISE_EXACT.has(t) || NOISE_PATTERN.test(t));
    })
    .join("\n");
}

function clean(s) {
  return stripNoise(s)
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------- snapshots ----------

function hashKey(role, s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return role + ":" + h + ":" + s.length;
}

const cache = new WeakMap();

function snapshot() {
  const out = [];
  for (const { el, role } of collectElements()) {
    let md = cache.get(el);
    if (md === undefined) {
      md = clean(walk(el));
      cache.set(el, md);
    }
    if (md) out.push({ role, md, key: hashKey(role, md) });
  }
  return out;
}

// ---------- merging ----------
// The page only keeps messages near the screen in the DOM (plus the newest
// one), so every snapshot is a window. We merge each window into the running
// list by order, matching messages that are already known, so nothing is
// counted twice and identical messages (like repeated "next") stay separate.
// Unmatched new messages are placed BEFORE known ones, because we scroll up.

let weakLinks = 0;

function mergeSeq(all, v) {
  const n = all.length, m = v.length;
  if (!n) return { merged: v.slice(), matched: 0 };
  if (!m) return { merged: all, matched: 0 };

  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = all[i].key === v[j].key
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out = [];
  let i = 0, j = 0, matched = 0;
  while (i < n && j < m) {
    if (all[i].key === v[j].key) {
      out.push(all[i]); i++; j++; matched++;
    } else if (dp[i + 1][j] > dp[i][j + 1]) {
      out.push(all[i]); i++;
    } else {
      out.push(v[j]); j++; // tie or better on the v side: new (older) message goes first
    }
  }
  while (i < n) out.push(all[i++]);
  while (j < m) out.push(v[j++]);
  return { merged: out, matched };
}

function addSnapshot(all) {
  const v = snapshot();
  const { merged, matched } = mergeSeq(all, v);
  // Only the newest message matched while the window has more: the windows
  // may not have overlapped, so something between them could be missing.
  if (all.length > 1 && v.length > 1 && matched <= 1) weakLinks++;
  return merged;
}

// ---------- diagnostics when nothing matches ----------

function selectorReport() {
  const lines = [];
  for (const key of ["userMessage", "assistantMessage"]) {
    SELECTORS[key].forEach((s) => {
      let n = "invalid";
      try { n = document.querySelectorAll(s).length; } catch (e) {}
      lines.push(key + " " + s + " -> " + n);
    });
  }
  const counts = {};
  document.querySelectorAll("[data-testid]").forEach((e) => {
    const v = e.getAttribute("data-testid");
    counts[v] = (counts[v] || 0) + 1;
  });
  const top = Object.entries(counts)
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([v, n]) => v + " x" + n);
  lines.push("repeated data-testid: " + (top.join(", ") || "none"));
  return lines.join(" | ");
}

// ---------- main ----------

async function readChat() {
  progress("Finding messages...");
  const first = collectElements();
  if (!first.length) {
    return { error: "No messages matched. " + selectorReport() };
  }

  const scroller = findScroller(first[0].el);
  weakLinks = 0;

  // start from the bottom so the newest messages are captured first
  scroller.scrollTop = scroller.scrollHeight;
  await sleep(1200);

  let all = addSnapshot([]);
  weakLinks = 0;

  let steps = 0;
  let stable = 0;
  let lastHeight = scroller.scrollHeight;
  let lastCount = all.length;

  while (steps < 2500) {
    steps++;
    const step = Math.max(200, Math.floor(scroller.clientHeight * 0.5));
    scroller.scrollTop = Math.max(0, scroller.scrollTop - step);
    await sleep(300);
    all = addSnapshot(all);

    if (steps % 5 === 0) progress("Loading conversation... " + all.length + " messages found");

    if (scroller.scrollTop <= 0) {
      await sleep(1500); // let older messages load
      all = addSnapshot(all);
      const h = scroller.scrollHeight;
      if (h === lastHeight && all.length === lastCount) stable++;
      else stable = 0;
      lastHeight = h;
      lastCount = all.length;
      if (stable >= 2) break;
    }
  }

  scroller.scrollTop = scroller.scrollHeight; // put the user back at the bottom

  const title = document.title.replace(/\s*[-–|]\s*Claude\s*$/i, "").trim() || "Claude chat";
  const userCount = all.filter((m) => m.role === "user").length;

  let md = "# " + title + "\n\n";
  md += "- Source: Claude (claude.ai)\n";
  md += "- URL: " + location.href + "\n";
  md += "- Captured: " + new Date().toISOString() + "\n";
  md += "- Messages: " + all.length + " (" + userCount + " from you, " + (all.length - userCount) + " from Claude)\n\n---\n\n";
  md += all.map((m) => "## " + (m.role === "user" ? "You" : "Claude") + "\n\n" + m.md).join("\n\n");
  md += "\n\n<!-- DomScrap debug: userSelector=" + usedSelectors.user +
        "; assistantSelector=" + usedSelectors.assistant +
        "; scrollSteps=" + steps + "; weakLinks=" + weakLinks + " -->\n";

  return { markdown: md, title, count: all.length };
}

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (msg.type === "READ_CHAT") {
    readChat().then(send).catch((e) => send({ error: String(e) }));
    return true; // keep the channel open for the async reply
  }
});