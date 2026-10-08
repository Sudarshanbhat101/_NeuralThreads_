// All page-specific knowledge lives here. When Claude changes its markup,
// this is the only file you should need to edit.
//
// Each entry is a LIST of selectors. content.js tries them in order and uses
// the first one that matches something. Put the most stable one first.

const SELECTORS = {
  // One element per message you wrote
  userMessage: [
    '[data-testid="user-message"]',
  ],

  // One element per Claude reply
  assistantMessage: [
    '[data-is-streaming]',
    '.font-claude-message',
  ],

  // Parts inside a message that should NOT end up in the markdown
  ignore: [
    "button",
    "svg",
    "[aria-hidden='true']",
    "style",
    "script",
  ],

  // The scrolling area of the chat. Empty means "detect it automatically".
  scroller: [],
};