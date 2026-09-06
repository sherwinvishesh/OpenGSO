import { c } from '../../shared/log.js';
import type { Rgb } from './paint.js';
import { centre, fg, glyphs, gradient, mix, padEnd, terminalWidth, truncate, visibleWidth } from './paint.js';
import { PALETTE, bandBright, bandColour, contentBand, ink, structuralBand } from './theme.js';

/**
 * The drawing vocabulary: meters, boxes, lists, sparklines, spinners.
 *
 * Every one of these returns a string or an array of strings rather than writing anywhere. That is
 * what lets the report use the same meter the full-screen home screen uses, and lets all of it be
 * tested without a terminal.
 */

/**
 * A horizontal meter with sub-character resolution.
 *
 * A 24-cell bar of `#` can only express the score in steps of about four points, so 96 and 98 draw
 * identically and the bar stops being a reading of the number beside it. The eighth-block glyphs
 * give the last cell eight positions, and the whole bar is ramped from the band's darker shade to
 * its brighter one so a long bar has some life in it.
 */
export function meter(value: number, width: number, options: { scale?: 'structural' | 'content'; max?: number } = {}): string {
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
 */
export function progressMeter(done: number, total: number, width: number): string {
  const ratio = total <= 0 ? 0 : Math.max(0, Math.min(1, done / total));
  return drawMeter(ratio, width, PALETTE.info, PALETTE.okBright);
}

/** The shared drawing: whole blocks, one eighth-block for the remainder, faint cells for the rest. */
function drawMeter(ratio: number, width: number, from: Rgb, to: Rgb): string {
  const g = glyphs();
  const exact = ratio * width;
  const full = Math.floor(exact);
  const remainder = exact - full;
  const cells: string[] = [];
  for (let index = 0; index < full && index < width; index += 1) {
    cells.push(fg(mix(from, to, width === 1 ? 1 : index / (width - 1)), g.blocks[7]!));
  }
  if (full < width && remainder > 0.05) {
    const step = Math.min(6, Math.max(0, Math.round(remainder * 8) - 1));
    cells.push(fg(mix(from, to, width === 1 ? 1 : full / (width - 1)), g.blocks[step]!));
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
 */
export function lockedMeter(value: number, locked: number, width: number): string {
  const g = glyphs();
  const band = structuralBand(value);
  const filled = Math.round((Math.max(0, Math.min(100, value)) / 100) * width);
  const ghost = Math.min(width - filled, Math.round((Math.max(0, locked) / 100) * width));
  const lit = Array.from({ length: filled }, (_, index) =>
    fg(mix(bandColour(band), bandBright(band), width === 1 ? 1 : index / (width - 1)), g.blocks[7]!),
  ).join('');
  return lit + ink.faint(g.ghost.repeat(Math.max(0, ghost))) + ink.faint(g.empty.repeat(Math.max(0, width - filled - ghost)));
}

/** A run of numbers as one line of eighth-blocks. Scaled to its own range so a flat run stays flat. */
export function sparkline(values: readonly number[], colour: Rgb = PALETTE.muted): string {
  if (values.length === 0) return '';
  const g = glyphs();
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low;
  return values
    .map((value) => {
      const step = span === 0 ? g.spark.length - 1 : Math.round(((value - low) / span) * (g.spark.length - 1));
      return g.spark[step]!;
    })
    .join('')
    .split('')
    .map((ch) => fg(colour, ch))
    .join('');
}

export interface BoxOptions {
  title?: string;
  /** Drawn at the far right of the top edge, e.g. a version. */
  tag?: string;
  width?: number;
  colour?: Rgb;
  padding?: number;
}

/**
 * A titled box around a block of lines.
 *
 * The title sits in the top edge rather than on a line of its own, which buys back a row and reads
 * as a frame instead of a heading with a rectangle under it.
 */
export function box(lines: readonly string[], options: BoxOptions = {}): string[] {
  const g = glyphs();
  const width = options.width ?? terminalWidth();
  const colour = options.colour ?? PALETTE.faint;
  const pad = options.padding ?? 1;
  const inner = width - 2 - pad * 2;
  const edge = (text: string) => fg(colour, text);

  const titlePart = options.title ? ` ${c.bold(options.title)} ` : '';
  const tagPart = options.tag ? ` ${ink.faint(options.tag)} ` : '';
  const used = visibleWidth(titlePart) + visibleWidth(tagPart);
  const fill = Math.max(0, width - 2 - used - 1);
  const top =
    edge(g.topLeft) + edge(g.horizontal) + titlePart + edge(g.horizontal.repeat(fill)) + tagPart + edge(g.topRight);

  const body = lines.map((line) => {
    const clipped = truncate(line, inner);
    return edge(g.vertical) + ' '.repeat(pad) + padEnd(clipped, inner) + ' '.repeat(pad) + edge(g.vertical);
  });

  const bottom = edge(g.bottomLeft + g.horizontal.repeat(width - 2) + g.bottomRight);
  return [top, ...body, bottom];
}

/** A full-width rule with an optional label sitting in it. The section divider for flat output. */
export function rule(label?: string, width = terminalWidth()): string {
  const g = glyphs();
  if (!label) return ink.faint(g.horizontal.repeat(width));
  const text = ` ${c.bold(label)} `;
  const rest = Math.max(0, width - visibleWidth(text) - 2);
  return ink.faint(g.horizontal.repeat(2)) + text + ink.faint(g.horizontal.repeat(rest));
}

export interface ListItem<T> {
  value: T;
  label: string;
  note?: string;
  /** Rendered dim and unselectable. */
  disabled?: boolean;
}

/**
 * The selectable list.
 *
 * The selected row is marked with an arrow and its label brightened rather than given a background:
 * a reverse-video bar looks wrong on half the colour schemes in use, and the arrow reads at a glance
 * on all of them.
 */
export function listView<T>(items: readonly ListItem<T>[], selected: number, options: { width?: number } = {}): string[] {
  const g = glyphs();
  const width = options.width ?? terminalWidth();
  const labelWidth = Math.max(...items.map((item) => visibleWidth(item.label)), 4);
  return items.map((item, index) => {
    const active = index === selected;
    const marker = active ? ink.accent(g.arrow) : ' ';
    // Padded only when something follows it. A row with no note would otherwise end in whatever
    // the longest label in the list needed, which is invisible on screen and ugly the moment
    // anybody copies the menu out of their terminal.
    const text = item.note ? padEnd(item.label, labelWidth) : item.label;
    const label = item.disabled ? ink.faint(text) : active ? c.bold(text) : text;
    const note = item.note ? `  ${ink.faint(item.note)}` : '';
    return truncate(`  ${marker} ${label}${note}`, width);
  });
}

/** A one-line text field with a visible caret. Scrolls horizontally once the value outgrows the box. */
export function textField(value: string, caret: number, options: { width?: number; placeholder?: string } = {}): string {
  const width = options.width ?? 48;
  if (value === '' && options.placeholder) return ink.faint(truncate(options.placeholder, width));
  const start = Math.max(0, caret - width + 1);
  const window = value.slice(start, start + width);
  const local = caret - start;
  const before = window.slice(0, local);
  const at = window.slice(local, local + 1) || ' ';
  const after = window.slice(local + 1);
  return `${before}${invert(at)}${after}`;
}

function invert(text: string): string {
  const ESC = String.fromCharCode(27);
  return `${ESC}[7m${text}${ESC}[27m`;
}

/** A small coloured label. Used for statuses that are one word. */
export function badge(text: string, colour: Rgb): string {
  return fg(colour, `${text}`);
}

/** A filled status dot, for a row that is reporting a state rather than a measurement. */
export function dot(colour: Rgb): string {
  return fg(colour, glyphs().dot);
}

/** The key hints along the bottom of a full-screen view. */
export function keyHints(pairs: ReadonlyArray<[string, string]>): string {
  return `  ${pairs.map(([key, what]) => `${c.bold(key)} ${ink.faint(what)}`).join(ink.faint('   '))}`;
}

/** The product wordmark, ramped. Drawn once at the top of a full-screen view. */
export function wordmark(): string {
  return gradient('OpenGEO', PALETTE.ok, PALETTE.okBright);
}

/** Centre a line inside a width, for an empty state or a splash. */
export function centred(text: string, width = terminalWidth()): string {
  return centre(text, width);
}

/**
 * Spinner frames, advanced by the caller.
 *
 * No timer lives in here. The thing that redraws owns the clock, because a spinner with its own
 * `setInterval` keeps the event loop alive after the work finishes and the process hangs on exit.
 */
export function spinnerFrame(tick: number): string {
  const frames = glyphs().spinner;
  return ink.accent(frames[tick % frames.length]!);
}
