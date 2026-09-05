import type { AiBot } from '../shared/bots.js';
import type { ProbeResult } from '../shared/http.js';
import { BROWSER_UA, probe } from '../shared/http.js';
import { twinUrl } from '../shared/routes.js';
import { parseLinkAlternate } from '../prod/headers.js';

/**
 * Everything the checks need, gathered in one pass.
 *
 * Probing is separated from checking so the check functions stay pure and testable against
 * synthetic evidence - no network, no timing flakiness, in the unit tests.
 */

/** A User-Agent a site would recognise as a well-known AI crawler. Used for the B10 probe. */
export const GPTBOT_UA = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot';

export interface Evidence {
  target: URL;
  origin: string;
  /** The page fetched the way a browser would. */
  html: ProbeResult;
  robots: ProbeResult;
  llms: ProbeResult;
  sitemap: ProbeResult;
  /** The markdown twin, fetched at its canonical URL (or the one the HTML advertised). */
  twin: ProbeResult;
  twinUrl: string;
  advertisedTwinUrl?: string;
  /** Same page URL, asking for markdown by content negotiation. */
  acceptMarkdown: ProbeResult;
  /** Same page URL, as a known AI bot, with no markdown preference expressed. */
  botUa: ProbeResult;
  /** Same page URL, with an Accept header that allows neither HTML nor markdown. */
  notAcceptable: ProbeResult;
  /**
   * The crawler catalogue A1 reads robots.txt against. Defaults to the shipped list; a caller with
   * a config in hand passes the resolved one so a project's own crawler is judged too.
   */
  bots?: readonly AiBot[];
}

export interface GatherOptions {
  timeoutMs?: number;
  bots?: readonly AiBot[];
}

export async function gatherEvidence(target: URL, options: GatherOptions = {}): Promise<Evidence> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const origin = target.origin;

  const html = await probe(target.toString(), {
    headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    timeoutMs,
  });

  const advertisedTwinUrl = resolveAdvertised(html, target);
  const canonicalTwinUrl = advertisedTwinUrl ?? twinUrl(target.toString());

  const [robots, llms, sitemap, twin, acceptMarkdown, botUa, notAcceptable] = await Promise.all([
    probe(new URL('/robots.txt', origin).toString(), { timeoutMs }),
    probe(new URL('/llms.txt', origin).toString(), { timeoutMs }),
    probe(new URL('/sitemap.xml', origin).toString(), { timeoutMs }),
    probe(canonicalTwinUrl, { headers: { Accept: 'text/markdown,*/*;q=0.5' }, timeoutMs }),
    probe(target.toString(), { headers: { Accept: 'text/markdown' }, timeoutMs }),
    probe(target.toString(), { headers: { 'User-Agent': GPTBOT_UA, Accept: '*/*' }, timeoutMs }),
    probe(target.toString(), { headers: { Accept: 'application/json' }, timeoutMs }),
  ]);

  return {
    target,
    origin,
    html,
    robots,
    llms,
    sitemap,
    twin,
    twinUrl: canonicalTwinUrl,
    advertisedTwinUrl,
    acceptMarkdown,
    botUa,
    notAcceptable,
    bots: options.bots,
  };
}

function resolveAdvertised(html: ProbeResult, target: URL): string | undefined {
  const advertised = parseLinkAlternate(html.headers.get('link'));
  if (!advertised) return undefined;
  try {
    return new URL(advertised, target).toString();
  } catch {
    return undefined;
  }
}
