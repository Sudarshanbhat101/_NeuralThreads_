// All page-specific knowledge lives here, one section per site.
// When a site changes its markup, edit only that site's section.
//
// Every selector list is tried IN ORDER. The first selector that matches
// something is used, so put the most stable one first and the weakest last.
//
// VERIFIED = confirmed on a real capture.
// GUESS    = written from memory of how the site looked, never tested here.
//            Safe if wrong: it matches nothing and the next one is tried.
//            The first run on ChatGPT and Gemini is a discovery run: use
//            "Copy debug info" and send me the result so I can correct these.

const SITES = {
  // ------------------------------------------------------------- Claude
  claude: {
    name: "Claude",
    hosts: ["claude.ai"],
    titleCleanup: "\\s*[-–|]\\s*Claude\\s*$",
    defaultTitle: "Claude chat",
    selectors: {
      userMessage: [
        '[data-testid="user-message"]',   // VERIFIED
        ".font-user-message",             // GUESS
        '[class*="user-message"]',        // GUESS
      ],
      assistantMessage: [
        "[data-is-streaming]",            // VERIFIED
        ".font-claude-message",           // GUESS
        '[class*="claude-message"]',      // GUESS
      ],
      ignore: ["button", "svg", "[aria-hidden='true']", "style", "script"],
      scroller: [],                       // empty = detect automatically
    },
    noise: {
      exact: ["Recalled memory", "Updated memory", "Used a tool", "Created a file"],
      patterns: [
        "^(Read|Ran|Searched|Viewed|Edited|Used) \\d+ [a-z]+(, [a-z0-9 ]+)*$",
      ],
    },
  },

  // ------------------------------------------------------------ ChatGPT
  chatgpt: {
    name: "ChatGPT",
    hosts: ["chatgpt.com", "chat.openai.com"],
    titleCleanup: "\\s*[-–|]\\s*ChatGPT\\s*$",
    defaultTitle: "ChatGPT chat",
    selectors: {
      userMessage: [
        '[data-message-author-role="user"]',        // GUESS (most confident)
        'article [data-testid*="user"]',            // GUESS
      ],
      assistantMessage: [
        '[data-message-author-role="assistant"]',   // GUESS (most confident)
        'article [data-testid*="assistant"]',       // GUESS
      ],
      ignore: [
        "button",
        "svg",
        "[aria-hidden='true']",
        ".sr-only",                                  // GUESS: screen-reader labels
        "style",
        "script",
      ],
      scroller: [],
    },
    noise: {
      exact: ["ChatGPT said:", "You said:", "Searching the web", "Searched the web"],
      patterns: [
        "^Thought for .{1,40}$",                     // GUESS: reasoning-time chip
      ],
    },
  },

  // ------------------------------------------------------------- Gemini
  gemini: {
    name: "Gemini",
    hosts: ["gemini.google.com"],
    titleCleanup: "\\s*[-–|]\\s*(Google )?Gemini\\s*$",
    defaultTitle: "Gemini chat",
    selectors: {
      userMessage: [
        "user-query",                                // GUESS (custom page tag)
        '[class*="user-query"]',                     // GUESS
      ],
      assistantMessage: [
        "model-response",                            // GUESS (custom page tag)
        "message-content",                           // GUESS
        '[class*="model-response"]',                 // GUESS
      ],
      ignore: [
        "button",
        "svg",
        "[aria-hidden='true']",
        ".cdk-visually-hidden",                      // GUESS: screen-reader labels
        ".sr-only",                                  // GUESS
        "style",
        "script",
      ],
      scroller: [],
    },
    noise: {
      exact: ["Show thinking", "Show drafts", "Gemini said", "You said"],
      patterns: [],
    },
  },
};

// ---------------------------------------------------------------------
// Pick the section that matches the page we are on.

function detectSiteId() {
  const host = location.hostname;
  for (const id of Object.keys(SITES)) {
    if (SITES[id].hosts.some((h) => host === h || host.endsWith("." + h))) return id;
  }
  return null;
}

const SITE_ID = detectSiteId();

// SITE: who we are talking to (name, title rules). Used by content.js later.
const SITE = SITE_ID
  ? Object.assign({ id: SITE_ID }, SITES[SITE_ID])
  : {
    id: null,
    name: "Unsupported site",
    hosts: [],
    titleCleanup: "",
    defaultTitle: "AI chat",
    selectors: { userMessage: [], assistantMessage: [], ignore: ["button", "svg", "style", "script"], scroller: [] },
    noise: { exact: [], patterns: [] },
  };

// These two names are what content.js already reads, so it keeps working
// without changes: they now point at the current site's section.
const SELECTORS = SITE.selectors;
const NOISE = SITE.noise;

// ---------------------------------------------------------------------
// Settings shared by every site.

// Last-resort method, used only when every selector above finds nothing.
// It looks for blocks that repeat inside the chat area and treats them as
// messages. Less accurate, so the popup warns when it is used.
const HEURISTIC = {
  enabled: false,
  minBlocks: 2,        // need at least this many repeating blocks
  minTextLength: 1,    // ignore blocks with less text than this
};

// Self-check rules run after every read. If one fails, the popup shows a
// warning instead of "Done".
const SANITY = {
  minMessages: 1,           // fewer than this = failed
  maxRoleDifference: 2,     // |your messages - assistant replies| above this = suspicious
  requireReachedTop: true,  // the scroll must have reached the top of the chat
};