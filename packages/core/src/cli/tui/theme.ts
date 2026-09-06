import type { Rgb } from './paint.js';
import { fg, gradient, hex } from './paint.js';

/**
 * One palette for the terminal, deliberately the same hues as the dashboard's CSS tokens.
 *
 * The two halves of OpenGEO are one product, and a green that means "passing" in the browser has to
 * be the same green that means "passing" in the report. These are the dark-theme values from
 * `packages/opengeo/web/src/styles.css`, nudged up in lightness: a terminal background is not
 * guaranteed to be dark, and a colour picked for `#131413` disappears on a white profile.
 */
export const PALETTE = {
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
} as const;

/**
 * The band a 0-100 score falls in.
 *
 * Two scales exist because the two numbers are not the same measurement: a structural audit is a
 * checklist and 85 is a reasonable "good", while a model's opinion of prose clusters lower and 75
 * is the honest line. They were already both here, written out four times between `renderScore`,
 * `renderBar` and `scoreColour`. Now they are named, in one place.
 */
export type Band = 'good' | 'fair' | 'poor';

export function structuralBand(score: number): Band {
  return score >= 85 ? 'good' : score >= 60 ? 'fair' : 'poor';
}

export function contentBand(score: number): Band {
  return score >= 75 ? 'good' : score >= 50 ? 'fair' : 'poor';
}

export function bandColour(band: Band): Rgb {
  return band === 'good' ? PALETTE.ok : band === 'fair' ? PALETTE.warn : PALETTE.danger;
}

export function bandBright(band: Band): Rgb {
  return band === 'good' ? PALETTE.okBright : band === 'fair' ? PALETTE.warnBright : PALETTE.dangerBright;
}

/** Paint text in a score's own colour, whichever of the two scales it belongs to. */
export function scoreInk(score: number, text: string, scale: 'structural' | 'content' = 'structural'): string {
  return fg(bandColour(scale === 'structural' ? structuralBand(score) : contentBand(score)), text);
}

/** A score's headline, ramped from its darker to its brighter shade so the number reads as lit. */
export function scoreHeadline(score: number, text: string, scale: 'structural' | 'content' = 'structural'): string {
  const band = scale === 'structural' ? structuralBand(score) : contentBand(score);
  return gradient(text, bandColour(band), bandBright(band));
}

export const ink = {
  ok: (text: string) => fg(PALETTE.ok, text),
  warn: (text: string) => fg(PALETTE.warn, text),
  danger: (text: string) => fg(PALETTE.danger, text),
  accent: (text: string) => fg(PALETTE.accent, text),
  info: (text: string) => fg(PALETTE.info, text),
  muted: (text: string) => fg(PALETTE.muted, text),
  faint: (text: string) => fg(PALETTE.faint, text),
};
