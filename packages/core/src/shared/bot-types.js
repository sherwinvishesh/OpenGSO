/**
 * The shape of a crawler, shipped or user-defined. Types only: `bots.js` holds the list itself.
 */

/** @typedef {'assistant' | 'search' | 'training'} BotKind */

/**
 * @typedef {object} AiBot
 * @property {string} name Canonical name, and the identifier a user writes in omnigeo.config.json.
 * @property {string} vendor
 * @property {string[]} uaPatterns Case-insensitive User-Agent substrings. Empty means robots.txt-only
 *   (no crawler to match).
 * @property {string} robotsToken The token used in robots.txt `User-agent:` lines.
 * @property {BotKind} kind
 * @property {string} [notes]
 * @property {boolean} [custom] True for a crawler the user defined in their own config rather than
 *   one shipped in `bots.js`.
 */

/**
 * A crawler the user added themselves, as it appears in `bots.custom` in omnigeo.config.json.
 *
 * The shipped list is updated by pull request, which is the right cadence for a shared list and
 * the wrong one for the person whose in-house agent started crawling yesterday. Everything except
 * the name has a sensible answer derived from it, so the minimum viable entry is
 * `{ "name": "AcmeBot" }`.
 *
 * @typedef {object} CustomBotInput
 * @property {string} name
 * @property {string} [vendor]
 * @property {string[]} [uaPatterns]
 * @property {string} [robotsToken]
 * @property {BotKind} [kind]
 * @property {string} [notes]
 */

export {};
