import { fg, gradient, hex } from './paint.js';

/** @import { Rgb } from './paint.js' */

/**
 * One palette for the terminal, deliberately the same hues as the dashboard's CSS tokens.
 *
 * The two halves of OpenGEO are one product, and a green that means "passing" in the browser has to
 * be the same green that means "passing" in the report. These are the dark-theme values from
 * `packages/opengeo/web/src/styles.css`, nudged up in lightness: a terminal background is not
 * guaranteed to be dark, and a colour picked for `#131413` disappears on a white profile.
 */
export const PALETTE = /* @__PURE__ */ Object.freeze({
  ok: hex('#4fb07a'),
  okBright: hex('#6cc294'),
  warn: hex('#c99038'),
  warnBright: hex('#dcae5c'),
  danger: hex('#d2685e'),
  dangerBright: hex('#e8837a'),
  accent: hex('#4fb07a'),
  info: hex('#5aa2d0'),
  muted: hex('#8a8a82'),
  faint: hex('#5c5c56'),
  text: hex('#c8c8c4'),
});

/**
 * The band a 0-100 score falls in.
 *
 * Two scales exist because the two numbers are not the same measurement: a structural audit is a
 * checklist and 85 is a reasonable "good", while a model's opinion of prose clusters lower and 75
 * is the honest line. They were already both here, written out four times between `renderScore`,
 * `renderBar` and `scoreColour`. Now they are named, in one place.
 *
 * @typedef {'good' | 'fair' | 'poor'} Band
 */

/**
 * @param {number} score
 * @returns {Band}
 */
export function structuralBand(score) {
  return score >= 85 ? 'good' : score >= 60 ? 'fair' : 'poor';
}

/**
 * @param {number} score
 * @returns {Band}
 */
export function contentBand(score) {
  return score >= 75 ? 'good' : score >= 50 ? 'fair' : 'poor';
}

/**
 * @param {Band} band
 * @returns {Rgb}
 */
export function bandColour(band) {
  return band === 'good' ? PALETTE.ok : band === 'fair' ? PALETTE.warn : PALETTE.danger;
}

/**
 * @param {Band} band
 * @returns {Rgb}
 */
export function bandBright(band) {
  return band === 'good' ? PALETTE.okBright : band === 'fair' ? PALETTE.warnBright : PALETTE.dangerBright;
}

/**
 * Paint text in a score's own colour, whichever of the two scales it belongs to.
 *
 * @param {number} score
 * @param {string} text
 * @param {'structural' | 'content'} [scale]
 * @returns {string}
 */
export function scoreInk(score, text, scale = 'structural') {
  return fg(bandColour(scale === 'structural' ? structuralBand(score) : contentBand(score)), text);
}

/**
 * A score's headline, ramped from its darker to its brighter shade so the number reads as lit.
 *
 * @param {number} score
 * @param {string} text
 * @param {'structural' | 'content'} [scale]
 * @returns {string}
 */
export function scoreHeadline(score, text, scale = 'structural') {
  const band = scale === 'structural' ? structuralBand(score) : contentBand(score);
  return gradient(text, bandColour(band), bandBright(band));
}

export const ink = {
  ok: (/** @type {string} */ text) => fg(PALETTE.ok, text),
  warn: (/** @type {string} */ text) => fg(PALETTE.warn, text),
  danger: (/** @type {string} */ text) => fg(PALETTE.danger, text),
  accent: (/** @type {string} */ text) => fg(PALETTE.accent, text),
  info: (/** @type {string} */ text) => fg(PALETTE.info, text),
  muted: (/** @type {string} */ text) => fg(PALETTE.muted, text),
  faint: (/** @type {string} */ text) => fg(PALETTE.faint, text),
};
