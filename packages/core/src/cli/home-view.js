import { c } from '../shared/log.js';
import { PALETTE, ink } from '../shared/render/theme.js';
import { relativeAge } from '../shared/history.js';
import { padEnd, terminalWidth, truncate } from '../shared/render/paint.js';
import { meter, sparkline } from '../shared/render/meters.js';
import { box, wordmark } from './tui/widgets.js';

/**
 * @import { CommandName } from '../shared/errors.js'
 * @import { CommandHandler } from './index.js'
 * @import { ListItem } from './tui/widgets.js'
 * @import { HomeStatus } from './home-status.js'
 */

/**
 * What the home screen draws: the header, the status rows and the menu entries. Each is a pure
 * function of a HomeStatus, so the rendering is testable without a terminal.
 */

/** @typedef {'test' | 'generate' | 'prod' | 'dashboard' | 'settings' | 'setup' | 'quit'} HomeAction */

/**
 * The header box: what this project is, and where it stands.
 *
 * @param {HomeStatus} status
 * @param {string} version
 * @param {number} [width]
 * @returns {string[]}
 */
export function homeHeader(status, version, width = terminalWidth()) {
  const inner = Math.max(24, Math.min(width, 96) - 4);
  /** @type {string[]} */
  const body = [];
  body.push(`${c.bold(status.project)}  ${ink.faint(status.site ?? 'no site configured yet')}`);
  body.push('');
  for (const row of statusRows(status, inner)) body.push(row);
  return box(body, { title: wordmark(), tag: version, width: Math.min(width, 96) });
}

const LABEL_WIDTH = 10;

/**
 * The status rows, each of which says "unknown" honestly rather than not appearing. The one
 * exception is Ideas, which needs a scored run to have anything to count.
 *
 * @param {HomeStatus} status
 * @param {number} width
 * @returns {string[]}
 */
export function statusRows(status, width) {
  /** @type {string[]} */
  const rows = [];
  /** @param {string} text */
  const label = (text) => ink.faint(padEnd(text, LABEL_WIDTH));

  if (!status.configured) {
    rows.push(`${label('Setup')}${ink.warn('not configured')}  ${ink.faint('press s to answer four questions')}`);
    return rows;
  }

  if (status.score) {
    const bar = meter(status.score.value, 16);
    const parts = [`${bar} ${c.bold(String(status.score.value))}`];
    if (typeof status.score.delta === 'number' && status.score.delta !== 0) {
      const sign = status.score.delta > 0 ? '+' : '';
      const paint = status.score.delta > 0 ? ink.ok : ink.danger;
      parts.push(paint(`${sign}${status.score.delta}`));
    }
    if (status.score.trend.length > 1) parts.push(sparkline(status.score.trend, PALETTE.muted));
    parts.push(ink.faint(relativeAge(status.score.at)));
    rows.push(`${label('Score')}${parts.join('  ')}`);
    // The second number, on its own row so it is never mistaken for part of the first.
    const ideas = status.score.suggestions;
    if (ideas && ideas.count > 0) {
      rows.push(`${label('Ideas')}${ideas.adopted} of ${ideas.count} suggestions adopted  ${ink.faint(ideas.adopted === ideas.count ? 'all of them' : 'see the test report')}`);
    }
  } else {
    rows.push(`${label('Score')}${ink.faint('never tested')}  ${ink.faint('press t')}`);
  }

  rows.push(
    status.twins > 0
      ? `${label('Twins')}${status.twins} ${status.twins === 1 ? 'page' : 'pages'}  ${ink.faint(status.generatedAt ? `generated ${relativeAge(status.generatedAt)}` : '')}`
      : `${label('Twins')}${ink.faint('none generated')}  ${ink.faint('press g')}`,
  );

  rows.push(
    status.provider
      ? `${label('AI key')}${status.provider.id}  ${ink.faint(`from ${status.provider.source}`)}`
      : `${label('AI key')}${ink.faint('none')}  ${ink.faint('optional, only the AI features need one')}`,
  );

  return rows.map((row) => truncate(row, width));
}

/**
 * The menu.
 *
 * An install that does not ship a command still shows its row, dimmed and unselectable. Hiding it
 * would make two installs look like the same product with a different number of features, when the
 * honest reading is that this one is narrower and the row says which package widens it.
 *
 * @param {Partial<Record<CommandName, CommandHandler>>} commands
 * @param {HomeStatus} status
 * @returns {Array<ListItem<HomeAction>>}
 */
export function homeEntries(commands, status) {
  /** @param {CommandName} name */
  const has = (name) => Boolean(commands[name]);
  /** @type {Array<ListItem<HomeAction>>} */
  const entries = [];

  if (!status.configured && has('settings')) {
    entries.push({ value: 'setup', label: 'Set up this project', note: 'four questions, then you are done' });
  }
  entries.push({ value: 'test', label: 'Test', note: 'score a live URL 0-100', disabled: !has('test') });
  entries.push({ value: 'generate', label: 'Generate', note: 'write the markdown twins', disabled: !has('generate') });
  entries.push({ value: 'prod', label: 'Prod check', note: 'probe the deployed middleware', disabled: !has('prod test') });
  entries.push({ value: 'dashboard', label: 'Dashboard', note: 'the same thing in a browser', disabled: !has('start') });
  entries.push({ value: 'settings', label: 'Settings', note: 'site, crawlers, AI key', disabled: !has('settings') });
  entries.push({ value: 'quit', label: 'Quit' });
  return entries;
}

/**
 * The status rows with no colour and no meters, for the flat menu.
 *
 * @param {HomeStatus} status
 * @returns {string[]}
 */
export function plainStatus(status) {
  if (!status.configured) return ['  not configured yet'];
  const ideas = status.score?.suggestions;
  const rows = [
    status.score ? `  score    ${status.score.value}/100, ${relativeAge(status.score.at)}` : '  score    never tested',
    ideas && ideas.count > 0 ? `  ideas    ${ideas.adopted} of ${ideas.count} suggestions adopted` : '',
    status.twins > 0 ? `  twins    ${status.twins} pages` : '  twins    none generated',
    status.provider ? `  ai key   ${status.provider.id}` : '  ai key   none',
  ];
  return rows.filter(Boolean);
}
