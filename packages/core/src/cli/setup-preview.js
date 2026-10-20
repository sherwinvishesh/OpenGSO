import { c } from '../shared/log.js';
import { twinUrl } from '../shared/routes.js';
import { ink } from '../shared/render/theme.js';

/** @import { SitePreview } from '../shared/site-probe.js' */

/**
 * The probe as two or three lines under the URL prompt.
 *
 * Written so that every line is either a fact about the response or a consequence of it. "Reachable"
 * on its own is not worth the round trip; "reachable, Next.js, and the content is in the HTML" tells
 * somebody that generate is going to work before they run it.
 *
 * @param {SitePreview} preview
 * @returns {string[]}
 */
export function previewLines(preview) {
  if (preview.error) {
    return [
      ink.warn(`Could not reach ${preview.url}: ${preview.error}`),
      c.gray('Setup carries on. The URL is saved either way, and nothing here is a blocker.'),
    ];
  }
  if (!preview.ok) {
    return [
      ink.warn(`${preview.url} answered ${preview.status}.`),
      c.gray('Worth checking the URL, though the rest of setup does not depend on it.'),
    ];
  }

  const facts = [`${preview.status} in ${preview.ttfbMs}ms`];
  if (preview.framework) facts.push(preview.framework);
  const lines = [`${ink.ok('Reachable')} ${c.gray(`(${facts.join(', ')})`)}`];

  if (preview.clientRendered) {
    lines.push(ink.warn('The raw HTML is an empty mount element, so the content only exists after JavaScript runs.'));
    lines.push(c.gray('Agents mostly do not run it, and neither does generate. Server-rendering is the fix.'));
  }

  if (preview.twin?.served) {
    lines.push(`${ink.ok('A markdown twin is already being served')} ${c.gray(`at ${preview.twin.url}, by omnigeo-prod.`)}`);
  } else if (preview.twin?.ok) {
    lines.push(`${ink.ok('Something already answers')} ${c.gray(`at ${preview.twin.url}, without OmniGEO's headers.`)}`);
  } else {
    lines.push(c.gray(`No twin at ${preview.twin?.url ?? twinUrl(preview.url)} yet. That is what generate and prod are for.`));
  }
  return lines;
}
