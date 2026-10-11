// Runs inside the AI chat page. Uses SITE, SELECTORS, NOISE, HEURISTIC and
// SANITY from selectors.js (loaded first by the manifest).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function progress(text) {
  try {
    chrome.runtime.sendMessage({ type: "PROGRESS", text }).catch(() => { });
  } catch (e) { }
}

// ---------- settings (safe defaults if selectors.js is older) ----------

const SITE_NAME = typeof SITE !== "undefined" && SITE.name ? SITE.name : "the AI";
const CFG_NOISE = typeof NOISE !== "undefined" ? NOISE : { exact: [], patterns: [] };
const CFG_SANITY =
  typeof SANITY !== "undefined"
    ? SANITY
    : { minMessages: 1, maxRoleDifference: 2, requireReachedTop: true };
const CFG_HEUR =
  typeof HEURISTIC !== "undefined"
    ? HEURISTIC
    : { enabled: true, minBlocks: 2, minTextLength: 1 };

const NOISE_EXACT = new Set(CFG_NOISE.exact || []);
const NOISE_PATTERNS = (CFG_NOISE.patterns || [])
  .map((p) => { try { return new RegExp(p, "i"); } catch (e) { return null; } })
  .filter(Boolean);

// Attachment detection. The tile selectors are GUESSES: if documents are not
// noted in a capture, send me the debug text and we adjust this list.
const ATTACH = {
  tileSelectors: [
    '[data-testid*="file"]',
    '[data-testid*="attachment"]',
    '[data-testid*="document"]',
    '[data-testid*="thumbnail"]',
  ],
  minImageSize: 40, // smaller images (icons, emoji, favicons) are ignored
};
const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|heic|avif)$/i;

// Heading labels that sites add to every reply for screen readers.
const LABEL_HEADING = /^(Claude responded|ChatGPT said|Gemini said|You said)\s*:?\s*/i;

// ---------- finding messages ----------

function pickAll(list) {
  for (let i = 0; i < list.length; i++) {
    try {
      const nodes = Array.from(document.querySelectorAll(list[i]));
      if (nodes.length) return { selector: list[i], level: i, nodes };
    } catch (e) { }
  }
  return { selector: null, level: -1, nodes: [] };
}

let lastMethod = { kind: "none", userSel: null, assistantSel: null, userLevel: -1, assistantLevel: -1 };
let heuristicParent = null;

const BAD_CHILD_TAGS = new Set([
  "p", "li", "tr", "td", "th", "span", "code", "pre", "a", "em", "strong", "b", "i",
  "h1", "h2", "h3", "h4", "h5", "h6", "br", "img", "svg", "button", "script", "style",
]);

function heuristicRoot() {
  let best = null, bestH = 0;
  document.querySelectorAll("*").forEach((el) => {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 20 && el.scrollHeight > bestH) {
      best = el;
      bestH = el.scrollHeight;
    }
  });
  return best || document.querySelector("main") || document.body;
}

function heuristicKids(p) {
  return Array.from(p.children).filter(
    (c) =>
      !BAD_CHILD_TAGS.has(c.tagName.toLowerCase()) &&
      c.textContent.trim().length >= CFG_HEUR.minTextLength
  );
}

// Last resort: inside the chat area, find the element with the most repeating
// block children. Those blocks are most likely the messages.
function findHeuristicParent() {
  const root = heuristicRoot();
  let best = null, bestScore = 0;
  const all = [root, ...root.querySelectorAll("*")];
  for (const p of all) {
    if (p.closest("pre, nav, ul, ol, table")) continue;
    const kids = heuristicKids(p);
    if (kids.length < CFG_HEUR.minBlocks) continue;
    if (kids.length > bestScore) { best = p; bestScore = kids.length; }
  }
  return best;
}

// ---------- only look at the chat the user is actually viewing ----------
// Some sites (ChatGPT) keep chats you opened earlier on the page, hidden.
// These helpers make sure we only read what is visible.

function isVisible(el) {
  if (!el || !el.isConnected) return false;
  if (el.getClientRects().length === 0) return false; // display:none and similar
  const st = getComputedStyle(el);
  if (st.visibility === "hidden" || st.display === "none") return false;
  if (el.closest("[hidden], [inert]")) return false;
  return true;
}

function viewportArea(el) {
  const r = el.getBoundingClientRect();
  const w = Math.max(0, Math.min(r.right, window.innerWidth) - Math.max(r.left, 0));
  const h = Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
  return w * h;
}

// The scroll area of the chat being viewed, if the site's section names one.
// If several match (old hidden chats), the one most visible on screen wins.
function getScope() {
  const list = (SELECTORS.scroller || []);
  for (const sel of list) {
    let nodes = [];
    try { nodes = Array.from(document.querySelectorAll(sel)); } catch (e) {}
    nodes = nodes.filter(isVisible).filter((n) => viewportArea(n) > 0);
    if (nodes.length) {
      nodes.sort((a, b) => viewportArea(b) - viewportArea(a));
      return nodes[0];
    }
  }
  return null;
}

// Like pickAll, but keeps only visible elements inside the scope.
// If that leaves nothing, falls back to the unfiltered result so that
// sites that already work (Claude, Gemini) cannot get worse.
function pickScoped(list, scope) {
  for (let i = 0; i < list.length; i++) {
    let nodes = [];
    try { nodes = Array.from(document.querySelectorAll(list[i])); } catch (e) {}
    nodes = nodes.filter(isVisible);
    if (scope) nodes = nodes.filter((n) => scope.contains(n));
    if (nodes.length) return { selector: list[i], level: i, nodes };
  }
  return pickAll(list);
}

function collectElements() {
  const scope = getScope();
  const u = pickScoped(SELECTORS.userMessage, scope);
  const a = pickScoped(SELECTORS.assistantMessage, scope);

  let items = [
    ...u.nodes.map((el) => ({ el, role: "user" })),
    ...a.nodes.map((el) => ({ el, role: "assistant" })),
  ];

  if (items.length) {
    lastMethod = {
      kind: "selectors",
      userSel: u.selector, assistantSel: a.selector,
      userLevel: u.level, assistantLevel: a.level,
    };
    // drop elements nested inside another selected element
    items = items.filter((x) => !items.some((y) => y !== x && y.el.contains(x.el)));
    // page order
    items.sort((x, y) =>
      x.el.compareDocumentPosition(y.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    );
    return items;
  }

  if (CFG_HEUR.enabled) {
    if (!heuristicParent || !heuristicParent.isConnected) heuristicParent = findHeuristicParent();
    if (heuristicParent) {
      lastMethod = { kind: "heuristic", userSel: null, assistantSel: null, userLevel: -1, assistantLevel: -1 };
      // roles cannot be told apart reliably by shape, so they stay "unknown"
      return heuristicKids(heuristicParent).map((el) => ({ el, role: "unknown" }));
    }
  }

  lastMethod = { kind: "none", userSel: null, assistantSel: null, userLevel: -1, assistantLevel: -1 };
  return [];
}

function findScroller(fromEl) {
  const scoped = getScope();
  if (scoped) return scoped;
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
    case "img": return ""; // images are noted separately by attachNotes()
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
      const t = kids().trim();
      // screen-reader heading the page adds to every reply: drop it
      if (LABEL_HEADING.test(t) && t.replace(LABEL_HEADING, "").length < 3) return "";
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

// ---------- images and documents ----------
// We do not save the files themselves, only a note that they were there.

function fileNameFrom(text) {
  const lines = (text || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const withExt = lines.find((l) => /\.[a-z0-9]{2,5}$/i.test(l));
  return (withExt || lines[0] || "").slice(0, 80);
}

function attachNotes(el) {
  const notes = [];
  const seen = new Set();
  const add = (kind, name) => {
    const line = "[" + kind + " attached" + (name ? ": " + name : "") + "]";
    if (!seen.has(line)) { seen.add(line); notes.push(line); }
  };

  try {
    // 1) attachment tiles (documents, and image thumbnails shown as tiles)
    let tiles = [];
    ATTACH.tileSelectors.forEach((sel) => {
      try { el.querySelectorAll(sel).forEach((t) => tiles.push(t)); } catch (e) { }
    });
    tiles = tiles.filter((t) => !tiles.some((o) => o !== t && o.contains(t))); // outermost only

    tiles.forEach((t) => {
      const name = fileNameFrom(t.innerText || t.textContent);
      const hasImg = !!t.querySelector("img");
      if (!name && !hasImg) return;
      const isImage = IMG_EXT.test(name) || (hasImg && !name);
      add(isImage ? "Image" : "Document", name);
    });

    // 2) standalone images that are not part of a tile
    el.querySelectorAll("img").forEach((img) => {
      if (tiles.some((t) => t.contains(img))) return;
      const size = Math.max(
        img.naturalWidth || 0,
        img.width || 0,
        parseInt(img.getAttribute("width") || "0", 10)
      );
      if (size && size < ATTACH.minImageSize) return;
      let name = (img.getAttribute("alt") || "").trim();
      if (!name) {
        const src = img.getAttribute("src") || "";
        if (src && !src.startsWith("data:") && !src.startsWith("blob:")) {
          try { name = decodeURIComponent(new URL(src, location.href).pathname.split("/").pop()); } catch (e) { }
        }
      }
      add("Image", name.slice(0, 80));
    });
  } catch (e) { }

  return notes;
}

// ---------- cleaning ----------

function stripNoise(s) {
  return s
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(NOISE_EXACT.has(t) || NOISE_PATTERNS.some((re) => re.test(t)));
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

function messageMd(el) {
  const notes = attachNotes(el);
  const body = clean(walk(el));
  return clean(notes.concat(body ? [body] : []).join("\n\n"));
}

// ---------- snapshots ----------

function hashKey(role, s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return role + ":" + h + ":" + s.length;
}

const cache = new WeakMap();
const emptyEls = new Set(); // elements that were found but had no content

function snapshot() {
  const out = [];
  for (const { el, role } of collectElements()) {
    let md = cache.get(el);
    if (md === undefined) {
      md = messageMd(el);
      if (md) { cache.set(el, md); emptyEls.delete(el); }
      else { emptyEls.add(el); } // not cached: it may still be loading
    }
    if (md) out.push({ role, md, key: hashKey(role, md) });
  }
  return out;
}

// ---------- merging ----------
// The page may keep only messages near the screen in the DOM, so every
// snapshot can be a window. Each window is lined up against the running list
// by order, so nothing is counted twice and identical messages (like repeated
// "next") stay separate. Unmatched messages are placed BEFORE known ones,
// because we scroll up.

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
      out.push(v[j]); j++;
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

// ---------- self-check ----------

function runSanity(all, reachedTop) {
  const warnings = [];

  if (all.length < CFG_SANITY.minMessages) {
    warnings.push("Too few messages were captured.");
  }

  if (lastMethod.kind === "heuristic") {
    warnings.push(
      "The normal message selectors found nothing, so a backup method was used. " +
      "Who wrote each message (you or " + SITE_NAME + ") is unknown and the capture may be inaccurate. " +
      "The " + SITE_NAME + " page has probably changed."
    );
  } else {
    const u = all.filter((m) => m.role === "user").length;
    const a = all.filter((m) => m.role === "assistant").length;
    if (Math.abs(u - a) > CFG_SANITY.maxRoleDifference) {
      warnings.push(
        "Your messages (" + u + ") and " + SITE_NAME + "'s replies (" + a + ") are unbalanced. " +
        "One of the selectors may have stopped matching."
      );
    }
  }

  if (CFG_SANITY.requireReachedTop && !reachedTop) {
    warnings.push("The scroll did not reach the top of the chat, so older messages may be missing.");
  }
  if (emptyEls.size) {
    warnings.push(emptyEls.size + " message block(s) came out empty and were skipped.");
  }
  if (weakLinks > 0) {
    warnings.push(weakLinks + " scroll step(s) did not overlap with earlier ones, so a message in between may be missing.");
  }
  return warnings;
}

// ---------- diagnostics when nothing matches ----------

function selectorReport() {
  const lines = [];
  const norm = (v) =>
    String(v)
      .replace(/[0-9a-f]{8}-[0-9a-f-]{20,}/gi, "UUID")
      .replace(/\d+/g, "N");

  // opening tag with its attributes only. Never includes message text.
  const tagInfo = (el) => {
    let s = "<" + el.tagName.toLowerCase();
    Array.from(el.attributes).forEach((a) => {
      if (a.name === "style" || a.name === "href" || a.name === "src") return;
      const v = a.name === "class" ? a.value.slice(0, 90) : norm(a.value).slice(0, 40);
      s += " " + a.name + '="' + v + '"';
    });
    return s + ">";
  };

  const chain = (el, max) => {
    const out = [];
    for (let e = el; e && e !== document.body && out.length < max; e = e.parentElement) {
      out.push(tagInfo(e));
    }
    return out.join(" < ");
  };

  lines.push("site: " + SITE_NAME + " (" + location.hostname + ")");
  lines.push("path: " + location.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{20,}/gi, "UUID"));

  for (const key of ["userMessage", "assistantMessage"]) {
    SELECTORS[key].forEach((s) => {
      let n = "invalid";
      try { n = document.querySelectorAll(s).length; } catch (e) {}
      lines.push(key + " " + s + " -> " + n);
    });
  }

  // the <section> and <main> elements
  Array.from(document.querySelectorAll("section")).slice(0, 6)
    .forEach((el, i) => lines.push("section " + i + ": " + tagInfo(el)));
  Array.from(document.querySelectorAll("main")).slice(0, 2)
    .forEach((el, i) => lines.push("main " + i + ": " + tagInfo(el)));

  // the biggest scrollable areas (to check we scroll the chat, not the sidebar)
  const scrollables = [];
  document.querySelectorAll("*").forEach((el) => {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 20) {
      scrollables.push(el);
    }
  });
  scrollables.sort((a, b) => b.scrollHeight - a.scrollHeight);
  scrollables.slice(0, 3).forEach((el, i) =>
    lines.push("scrollable " + i + " (height " + el.scrollHeight + "): " + tagInfo(el))
  );

  // parent chain above the first and the last Copy button
  const copies = Array.from(document.querySelectorAll('[aria-label="Copy"]'));
  if (copies.length) {
    lines.push("copy-first chain: " + chain(copies[0], 9));
    lines.push("copy-last chain: " + chain(copies[copies.length - 1], 9));
  }

  // anything that looks like a message action button
  ["Edit message", "Good response", "Bad response", "Read aloud"].forEach((label) => {
    const el = document.querySelector('[aria-label="' + label + '"]');
    if (el) lines.push('"' + label + '" chain: ' + chain(el, 9));
  });

  lines.push("backup method: " + (CFG_HEUR.enabled ? "tried, found nothing" : "disabled"));
  return lines.join(" | ");
}

// ---------- scrolling helpers ----------

function nearestScrollable(el) {
  for (let e = el && el.parentElement; e && e !== document.body; e = e.parentElement) {
    const oy = getComputedStyle(e).overflowY;
    if ((oy === "auto" || oy === "scroll") && e.scrollHeight > e.clientHeight + 20) return e;
  }
  return document.scrollingElement;
}

function describeEl(el) {
  if (!el) return "none";
  let s = el.tagName.toLowerCase();
  const label = el.getAttribute && el.getAttribute("aria-label");
  if (label) s += '[aria-label="' + label.slice(0, 30) + '"]';
  return s + " (content " + el.scrollHeight + "px, visible " + el.clientHeight + "px)";
}

// Move the chat up by one step. Tries several methods because sites differ.
function isAtTop(s, reversed) {
  const max = s.scrollHeight - s.clientHeight;
  if (max <= 2) return true; // nothing to scroll
  return reversed ? s.scrollTop <= -(max - 2) : s.scrollTop <= 1;
}

// Move the chat up by one step. Tries several methods because sites differ.
async function scrollUpStep(scroller, topEl, reversed) {
  const before = scroller.scrollTop;
  const step = Math.max(200, Math.floor(scroller.clientHeight * 0.5));

  try { scroller.scrollBy({ top: -step, behavior: "instant" }); } catch (e) {}
  await sleep(300);
  if (Math.abs(scroller.scrollTop - before) > 1) return { method: "scrollBy", moved: true };
  if (isAtTop(scroller, reversed)) return { method: "atTop", moved: false };

  scroller.scrollTop = before - step;
  await sleep(250);
  if (Math.abs(scroller.scrollTop - before) > 1) return { method: "scrollTop", moved: true };

  if (topEl && topEl.isConnected) {
    const r0 = topEl.getBoundingClientRect().top;
    try { topEl.scrollIntoView({ block: "start", behavior: "instant" }); } catch (e) {}
    await sleep(300);
    const r1 = topEl.getBoundingClientRect().top;
    if (Math.abs(r1 - r0) > 1 || Math.abs(scroller.scrollTop - before) > 1) {
      return { method: "scrollIntoView", moved: true };
    }
  }
  return { method: "none", moved: false };
}

// ---------- main ----------

async function readChat() {
  if (typeof SITE === "undefined" || !SITE.id) {
    return { error: "This site is not supported yet (" + location.hostname + ")." };
  }

  progress("Finding messages...");
  heuristicParent = null;
  emptyEls.clear();

  const first = collectElements();
  if (!first.length) {
    return { error: "No messages matched. " + selectorReport() };
  }

  let scroller = findScroller(first[0].el);
  const scrollerStart = describeEl(scroller);
  weakLinks = 0;

  // start from the bottom so the newest messages are captured first
  scroller.scrollBy({ top: 1e9, behavior: "instant" });
  await sleep(1200);
  let reversed = false;
  {
    const mx = scroller.scrollHeight - scroller.clientHeight;
    if (mx > 100 && Math.abs(scroller.scrollTop) < 5) reversed = true;
  }

  let all = addSnapshot([]);
  weakLinks = 0;

  let steps = 0;
  let stable = 0;
  let stuck = 0;
  let switched = 0;
  let reachedTop = false;
  const methods = {};
  let lastHeight = scroller.scrollHeight;
  let lastCount = all.length;
  let lastTopKey = all.length ? all[0].key : "";

  while (steps < 2500) {
    steps++;

    const items = collectElements();
    const topEl = items.length ? items[0].el : null;

    // the scroll area must contain the topmost message, or it is the wrong one
    if (topEl && !scroller.contains(topEl)) {
      const alt = nearestScrollable(topEl);
      if (alt && alt !== scroller) {
        scroller = alt;
        switched++;
        lastHeight = scroller.scrollHeight;
      }
    }

    const r = await scrollUpStep(scroller, topEl, reversed);
    methods[r.method] = (methods[r.method] || 0) + 1;
    all = addSnapshot(all);

    if (steps % 5 === 0) progress("Loading conversation... " + all.length + " messages found");

    if (isAtTop(scroller, reversed)) {
      // at the top: wait for older messages to load, then see if anything changed
      stuck = 0;
      await sleep(1500);
      all = addSnapshot(all);
      const h = scroller.scrollHeight;
      const topKey = all.length ? all[0].key : "";
      if (h === lastHeight && all.length === lastCount && topKey === lastTopKey) stable++;
      else stable = 0;
      lastHeight = h;
      lastCount = all.length;
      lastTopKey = topKey;
      if (stable >= 3) { reachedTop = true; break; }
    } else if (!r.moved) {
      // not at the top, but the scroll did not move: try another scroll area
      stuck++;
      if (stuck >= 3 && topEl) {
        const alt = nearestScrollable(topEl);
        if (alt && alt !== scroller) {
          scroller = alt;
          switched++;
          stuck = 0;
          lastHeight = scroller.scrollHeight;
        }
      }
      if (stuck >= 10) break; // stuck for good: reachedTop stays false
    } else {
      stuck = 0;
    }
  }

  const scrollerEnd = describeEl(scroller);
  scroller.scrollBy({ top: 1e9, behavior: "instant" }); // put the user back at the bottom

  const warnings = runSanity(all, reachedTop);

  const movedCount = steps - (methods.atTop || 0) - (methods.none || 0);
  if (movedCount === 0 && scroller.scrollHeight > scroller.clientHeight * 3) {
    warnings.push("The chat is much taller than the screen but the scroll never moved, so older messages are probably missing.");
  }

  let title = document.title || "";
  try {
    if (SITE.titleCleanup) title = title.replace(new RegExp(SITE.titleCleanup, "i"), "");
  } catch (e) {}
  title = title.trim() || SITE.defaultTitle || "AI chat";

  const userCount = all.filter((m) => m.role === "user").length;
  const aiCount = all.filter((m) => m.role === "assistant").length;
  const attachCount = all.reduce(
    (n, m) => n + (m.md.match(/^\[(Image|Document) attached/gm) || []).length, 0
  );

  const debug =
    "site=" + SITE.id + " (" + location.hostname + ")" +
    "; method=" + lastMethod.kind +
    "; userSelector=" + lastMethod.userSel + " (level " + lastMethod.userLevel + ")" +
    "; assistantSelector=" + lastMethod.assistantSel + " (level " + lastMethod.assistantLevel + ")" +
    "; messages=" + all.length + "; you=" + userCount + "; assistant=" + aiCount +
    "; scrollSteps=" + steps + "; reachedTop=" + reachedTop + "; reversed=" + reversed +
    "; scrollMethods=" + JSON.stringify(methods) + "; scrollerSwitches=" + switched +
    "; scrollerStart=" + scrollerStart + "; scrollerEnd=" + scrollerEnd +
    "; weakLinks=" + weakLinks + "; emptyBlocks=" + emptyEls.size +
    "; attachmentNotes=" + attachCount;

  const countLine =
    lastMethod.kind === "heuristic"
      ? all.length + " (roles unknown)"
      : all.length + " (" + userCount + " from you, " + aiCount + " from " + SITE_NAME + ")";
  const roleName = (r) => (r === "user" ? "You" : r === "assistant" ? SITE_NAME : "Message");

  let md = "# " + title + "\n\n";
  md += "- Source: " + SITE_NAME + " (" + location.hostname + ")\n";
  md += "- URL: " + location.href + "\n";
  md += "- Captured: " + new Date().toISOString() + "\n";
  md += "- Messages: " + countLine + "\n";
  if (warnings.length) {
    md += "- Capture warnings:\n" + warnings.map((w) => "  - " + w).join("\n") + "\n";
  }
  md += "\n---\n\n";
  md += all.map((m) => "## " + roleName(m.role) + "\n\n" + m.md).join("\n\n");
  md += "\n\n<!-- DomScrap debug: " + debug + " -->\n";

  return {
    markdown: md, title, count: all.length, warnings,
    method: lastMethod.kind, debug, site: SITE_NAME,
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (msg.type === "READ_CHAT") {
    readChat().then(send).catch((e) => send({ error: String(e) }));
    return true; // keep the channel open for the async reply
  }
});