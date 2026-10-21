#!/usr/bin/env node
/**
 * Render real captured terminal output as the animated SVG recording in the READMEs.
 *
 * Usage: node scripts/render-recording.mjs docs/images/recording docs/images/demo.svg
 *
 * The captures are the bytes `opengso` wrote, colour included, taken with
 * `FORCE_COLOR=3 opengso <command> > NN-name.ansi` against examples/nextjs-demo. This script never
 * invents output: it only decides when each captured line appears, types the three commands, and
 * scrolls a 30-row viewport the way a terminal would. Hand-rolled because it needs nothing beyond
 * Node, and so re-recording after a report change is one command rather than a screen capture.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SGR = /\x1b\[([0-9;]*)m/g;
const BASIC = ['#3b3b38', '#e8837a', '#6cc294', '#dcae5c', '#6fa8dc', '#c792ea', '#6dc3cf', '#d4d4cf'];
const BRIGHT = ['#7d7d77', '#f0938a', '#7fd3a6', '#e9bd6d', '#86b9e6', '#d6a5f0', '#86d2dc', '#ffffff'];
const FG = '#d4d4cf';
const BG = '#121413';
const BAR = '#1d201e';
const CW = 7.8; // column width at 13px Menlo, Consolas or DejaVu Sans Mono
const LH = 18;
const FS = 13;
const COLS = 96;
const ROWS = 30;
const PAD = 16;
const TITLE_H = 34;
const W = Math.round(COLS * CW + 2 * PAD);
const H = TITLE_H + ROWS * LH + 2 * PAD;
const X0 = PAD;
const Y0 = TITLE_H + PAD;

/** @typedef {{ text: string; fg: string | null; bold: boolean; dim: boolean }} Segment */
/**
 * @typedef {object} Scene
 * @property {number} id
 * @property {number} start
 * @property {number} end
 * @property {{ row: number; at: number; segs: Segment[] | null }[]} rows
 * @property {[number, number][]} scroll
 * @property {{ t: number; col: number; ch: string }[]} cmd
 * @property {[number, number][]} cursor
 * @property {number} tEnter
 */

/**
 * Split captured output into lines of coloured segments. SGR state persists across lines, as it
 * does in a terminal.
 * @param {string} text
 * @returns {Segment[][]}
 */
function parse(text) {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let state = { fg: /** @type {string | null} */ (null), bold: false, dim: false };
  return lines.map((line) => {
    /** @type {Segment[]} */
    const segs = [];
    let pos = 0;
    for (const m of line.matchAll(SGR)) {
      if (m.index > pos) segs.push({ text: line.slice(pos, m.index), ...state });
      const codes = m[1] ? m[1].split(';').filter(Boolean).map(Number) : [0];
      for (let i = 0; i < codes.length; i += 1) {
        const c = codes[i];
        if (c === 0) state = { fg: null, bold: false, dim: false };
        else if (c === 1) state = { ...state, bold: true };
        else if (c === 2) state = { ...state, dim: true };
        else if (c === 22) state = { ...state, bold: false, dim: false };
        else if (c === 39) state = { ...state, fg: null };
        else if (c >= 30 && c <= 37) state = { ...state, fg: BASIC[c - 30] };
        else if (c >= 90 && c <= 97) state = { ...state, fg: BRIGHT[c - 90] };
        else if (c === 38 && codes[i + 1] === 2 && codes.length > i + 4) {
          const [r, g, b] = codes.slice(i + 2, i + 5);
          state = { ...state, fg: `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}` };
          i += 4;
        } else if (c === 38 && codes[i + 1] === 5 && codes.length > i + 2) {
          const n = codes[i + 2];
          state = { ...state, fg: n < 8 ? BASIC[n] : n < 16 ? BRIGHT[n - 8] : FG };
          i += 2;
        }
      }
      pos = m.index + m[0].length;
    }
    if (pos < line.length) segs.push({ text: line.slice(pos), ...state });
    return segs;
  });
}

/** @param {string} s */
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** @param {number} n */
const num = (n) => String(Math.round(n * 1000) / 1000);

class Recording {
  t = 0;
  /** @type {Scene[]} */
  scenes = [];
  total = 0;

  /**
   * One cleared screen: a typed command, then the captured lines streaming in.
   * @param {string} cmd
   * @param {Segment[][]} lines
   * @param {{ spinner?: number; header?: number; headerHold?: number; dt?: number; hold?: number; topHold?: number }} opts
   */
  scene(cmd, lines, { spinner = 0, header = 0, headerHold = 1.4, dt = 0.035, hold = 3, topHold = 0 } = {}) {
    const start = this.t;
    let t = start + 0.7;
    /** @type {{ row: number; at: number; segs: Segment[] | null }[]} */
    const rows = [];
    /** @type {[number, number][]} */
    const scroll = [];
    let row = 0;
    /** @type {Scene['cmd']} */
    const cmdParts = [];
    /** @type {[number, number][]} */
    const cursor = [[start, 2]];
    for (let i = 0; i < cmd.length; i += 1) {
      t += [0.055, 0.04, 0.07, 0.045, 0.05][i % 5];
      cmdParts.push({ t, col: i + 2, ch: cmd[i] });
      cursor.push([t, i + 3]);
    }
    let tEnter = t + 0.45;
    row += 1;
    /** @param {(Segment[] | null)[]} src @param {number} at */
    const show = (src, at) => {
      for (const segs of src) {
        rows.push({ row, at, segs });
        row += 1;
        if (row > ROWS) scroll.push([at, row - ROWS]);
      }
    };
    let i = 0;
    if (spinner) {
      show(lines.slice(0, spinner), tEnter + 0.08);
      i = spinner;
      tEnter += 1.0;
    }
    if (header) {
      show(lines.slice(i, header), tEnter + 0.05);
      i = header;
      t = tEnter + 0.05 + headerHold;
    } else {
      t = tEnter + 0.05;
    }
    for (const segs of lines.slice(i)) {
      t += dt;
      show([segs], t);
    }
    const tDone = t + 0.3;
    show([null], tDone);
    let tEnd = tDone + hold;
    if (topHold) {
      scroll.push([tEnd, 0]);
      tEnd += topHold;
    }
    this.scenes.push({ id: this.scenes.length + 1, start, end: tEnd, rows, scroll, cmd: cmdParts, cursor, tEnter });
    this.t = tEnd;
  }

  /** @param {number} t */
  pct(t) {
    return `${((100 * t) / this.total).toFixed(3)}%`;
  }

  render() {
    this.total = this.t + 0.6;
    const dur = `${this.total.toFixed(2)}s`;
    const css =
      `text{font-family:"SFMono-Regular",Menlo,Consolas,"DejaVu Sans Mono","Liberation Mono",monospace;font-size:${FS}px;fill:${FG};white-space:pre}` +
      '.b{font-weight:700}.d{opacity:.65}' +
      `.a{animation-duration:${dur};animation-iteration-count:infinite;animation-timing-function:step-end;animation-fill-mode:both}` +
      '.cur{animation:blink 1.1s step-end infinite}' +
      '@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}';
    /** @type {string[]} */
    const kfs = [];
    /** @type {Map<string, string>} */
    const reveals = new Map();
    /** @param {number} t */
    const reveal = (t) => {
      const p = this.pct(t);
      let name = reveals.get(p);
      if (!name) {
        name = `r${reveals.size}`;
        reveals.set(p, name);
        kfs.push(`@keyframes ${name}{0%{opacity:0}${p},100%{opacity:1}}`);
      }
      return name;
    };
    /** @type {string[]} */
    const body = [];
    for (const sc of this.scenes) {
      const { id } = sc;
      const s = this.pct(sc.start);
      const e = this.pct(sc.end);
      kfs.push(
        sc.start === 0
          ? `@keyframes s${id}{0%{opacity:1}${e},100%{opacity:0}}`
          : `@keyframes s${id}{0%{opacity:0}${s}{opacity:1}${e},100%{opacity:0}}`,
      );
      const stops = ['0%{transform:translateY(0)}'];
      for (const [t, off] of sc.scroll) stops.push(`${this.pct(t)}{transform:translateY(${-off * LH}px)}`);
      const last = sc.scroll.length ? -sc.scroll[sc.scroll.length - 1][1] * LH : 0;
      stops.push(`100%{transform:translateY(${last}px)}`);
      kfs.push(`@keyframes sc${id}{${stops.join('')}}`);
      const g = [`<g class="a" style="animation-name:s${id}"><g class="a" style="animation-name:sc${id}">`];
      const y = num(Y0 + LH * 0.78);
      g.push(`<text x="${X0}" y="${y}" fill="${BASIC[2]}" class="b">$</text>`);
      for (const { t, col, ch } of sc.cmd) {
        g.push(`<text x="${num(X0 + col * CW)}" y="${y}" class="a" style="animation-name:${reveal(t)}">${esc(ch)}</text>`);
      }
      const cstops = [`0%{transform:translateX(${num(2 * CW)}px);opacity:1}`];
      for (const [t, col] of sc.cursor) cstops.push(`${this.pct(t)}{transform:translateX(${num(col * CW)}px);opacity:1}`);
      const lastCol = sc.cursor[sc.cursor.length - 1][1];
      cstops.push(`${this.pct(sc.tEnter)},100%{transform:translateX(${num(lastCol * CW)}px);opacity:0}`);
      kfs.push(`@keyframes cu${id}{${cstops.join('')}}`);
      g.push(
        `<rect x="${X0}" y="${Y0 + 2}" width="${CW}" height="${LH - 3}" fill="${BRIGHT[2]}" class="a" style="animation-name:cu${id}"/>`,
      );
      for (const { row, at, segs } of sc.rows) {
        const ly = num(Y0 + LH * (row + 0.78));
        if (segs === null) {
          g.push(
            `<g class="a" style="animation-name:${reveal(at)}"><text x="${X0}" y="${ly}" fill="${BASIC[2]}" class="b">$</text>` +
              `<rect x="${num(X0 + 2 * CW)}" y="${Y0 + LH * row + 2}" width="${CW}" height="${LH - 3}" fill="${BRIGHT[2]}" class="cur"/></g>`,
          );
          continue;
        }
        const n = segs.reduce((sum, seg) => sum + seg.text.length, 0);
        if (n === 0) continue;
        const spans = segs.map(({ text, fg, bold, dim }) => {
          const attrs = [];
          if (fg) attrs.push(`fill="${fg}"`);
          const cls = (bold ? 'b' : '') + (dim ? 'd' : '');
          if (cls) attrs.push(`class="${cls}"`);
          return `<tspan${attrs.length ? ` ${attrs.join(' ')}` : ''}>${esc(text)}</tspan>`;
        });
        g.push(
          `<text x="${X0}" y="${ly}" textLength="${num(n * CW)}" lengthAdjust="spacing" class="a" style="animation-name:${reveal(at)}">${spans.join('')}</text>`,
        );
      }
      g.push('</g></g>');
      body.push(g.join(''));
    }
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="monospace" role="img" aria-label="opengso test scores the demo 65 of 100, opengso generate writes the twins, opengso test scores it 100 of 100">`,
      '<!-- Real output of opengso against examples/nextjs-demo, rendered by scripts/render-recording.mjs from docs/images/recording/. -->',
      '<title>opengso test, generate, test: 65 to 100 on the Next.js demo</title>',
      `<style>${css}${kfs.join('')}</style>`,
      `<rect width="${W}" height="${H}" rx="10" fill="${BG}"/>`,
      `<path d="M0 10a10 10 0 0 1 10-10h${W - 20}A10 10 0 0 1 ${W} 10v${TITLE_H - 10}H0z" fill="${BAR}"/>`,
      '<circle cx="18" cy="17" r="5.5" fill="#ff5f57"/><circle cx="36" cy="17" r="5.5" fill="#febc2e"/><circle cx="54" cy="17" r="5.5" fill="#28c840"/>',
      `<text x="${W / 2}" y="21.5" text-anchor="middle" fill="#8a8a82" font-size="12">examples/nextjs-demo</text>`,
      `<clipPath id="v"><rect x="0" y="${TITLE_H}" width="${W}" height="${H - TITLE_H}"/></clipPath>`,
      '<g clip-path="url(#v)">',
      ...body,
      '</g></svg>',
    ].join('');
  }
}

const [recDir, out] = process.argv.slice(2);
if (!recDir || !out) {
  console.error('usage: node scripts/render-recording.mjs <captures dir> <out.svg>');
  process.exit(2);
}
/** @param {string} name */
const capture = (name) => parse(readFileSync(join(recDir, name), 'utf8'));
const r = new Recording();
r.scene('opengso test http://localhost:3000/resume', capture('01-before.ansi'), { spinner: 2, header: 8, headerHold: 1.6, hold: 3.2 });
r.scene('opengso generate http://localhost:3000', capture('02-generate.ansi'), { dt: 0.05, hold: 3 });
r.scene('opengso test http://localhost:3000/resume', capture('03-after.ansi'), { spinner: 2, header: 9, headerHold: 1.8, hold: 1.6, topHold: 4.5 });
const svg = r.render();
writeFileSync(out, svg);
console.log(`wrote ${out}: ${Buffer.byteLength(svg)} bytes, a ${r.total.toFixed(1)}s loop, ${W}x${H}`);
