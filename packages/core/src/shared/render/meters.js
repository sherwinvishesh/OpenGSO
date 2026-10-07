import { fg, glyphs, mix } from './paint.js';
import { PALETTE, bandBright, bandColour, contentBand, ink, structuralBand } from './theme.js';

/** @import { Rgb } from './paint.js' */

/**
 * Meters and sparklines: the score drawing the reports and the home screen share.
 *
 * They live here rather than with the interactive widgets so a pillar's report can draw a score
 * without importing anything from the CLI.
 */

/**
 * A horizontal meter with sub-character resolution.
 *
 * A 24-cell bar of `#` can only express the score in steps of about four points, so 96 and 98 draw
 * identically and the bar stops being a reading of the number beside it. The eighth-block glyphs
 * give the last cell eight positions, and the whole bar is ramped from the band's darker shade to
 * its brighter one so a long bar has some life in it.
 *
 * @param {number} value
 * @param {number} width
 * @param {{ scale?: 'structural' | 'content'; max?: number }} [options]
 * @returns {string}
 */
export function meter(value, width, options = {}) {
  const max = options.max ?? 100;
  const ratio = max === 0 ? 0 : Math.max(0, Math.min(1, value / max));
  const band = (options.scale ?? 'structural') === 'content' ? contentBand((value / max) * 100) : structuralBand((value / max) * 100);
  const from = bandColour(band);
  const to = bandBright(band);

  return drawMeter(ratio, width, from, to);
}

/**
 * A bar for work in progress, in one colour.
 *
 * `meter` paints by band, which is right for a score and wrong for progress: three routes into a
 * twelve route crawl is not a failing grade, and a red bar that turns green as it fills says it is.
 *
 * @param {number} done
 * @param {number} total
 * @param {number} width
 * @returns {string}
 */
export function progressMeter(done, total, width) {
  const ratio = total <= 0 ? 0 : Math.max(0, Math.min(1, done / total));
  return drawMeter(ratio, width, PALETTE.info, PALETTE.okBright);
}

/**
 * The shared drawing: whole blocks, one eighth-block for the remainder, faint cells for the rest.
 *
 * @param {number} ratio
 * @param {number} width
 * @param {Rgb} from
 * @param {Rgb} to
 * @returns {string}
 */
function drawMeter(ratio, width, from, to) {
  const g = glyphs();
  const exact = ratio * width;
  const full = Math.floor(exact);
  const remainder = exact - full;
  /** @type {string[]} */
  const cells = [];
  for (let index = 0; index < full && index < width; index += 1) {
    cells.push(fg(mix(from, to, width === 1 ? 1 : index / (width - 1)), g.blocks[7]));
  }
  if (full < width && remainder > 0.05) {
    const step = Math.min(6, Math.max(0, Math.round(remainder * 8) - 1));
    cells.push(fg(mix(from, to, width === 1 ? 1 : full / (width - 1)), g.blocks[step]));
  }
  const drawn = cells.length;
  return cells.join('') + ink.faint(g.empty.repeat(Math.max(0, width - drawn)));
}

/**
 * A meter with a second, dimmer segment behind it.
 *
 * Used for locked points: the earned part is lit, the locked part is shown as territory that exists
 * but is not being scored, and the rest is empty. Seeing the three lengths together is the whole
 * argument for why a locked check is not the same as a failed one.
 *
 * @param {number} value
 * @param {number} locked
 * @param {number} width
 * @returns {string}
 */
export function lockedMeter(value, locked, width) {
  const g = glyphs();
  const band = structuralBand(value);
  const filled = Math.round((Math.max(0, Math.min(100, value)) / 100) * width);
  const ghost = Math.min(width - filled, Math.round((Math.max(0, locked) / 100) * width));
  const lit = Array.from({ length: filled }, (_, index) =>
    fg(mix(bandColour(band), bandBright(band), width === 1 ? 1 : index / (width - 1)), g.blocks[7]),
  ).join('');
  return lit + ink.faint(g.ghost.repeat(Math.max(0, ghost))) + ink.faint(g.empty.repeat(Math.max(0, width - filled - ghost)));
}

/**
 * A run of numbers as one line of eighth-blocks. Scaled to its own range so a flat run stays flat.
 *
 * @param {readonly number[]} values
 * @param {Rgb} [colour]
 * @returns {string}
 */
export function sparkline(values, colour = PALETTE.muted) {
  if (values.length === 0) return '';
  const g = glyphs();
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low;
  return values
    .map((value) => {
      const step = span === 0 ? g.spark.length - 1 : Math.round(((value - low) / span) * (g.spark.length - 1));
      return g.spark[step];
    })
    .join('')
    .split('')
    .map((ch) => fg(colour, ch))
    .join('');
}
