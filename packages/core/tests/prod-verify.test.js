import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MARKDOWN_ROUTING,
  HEADERS,
  buildStartupStatus,
  createMemoryStore,
  handleRequest,
  identifyBot,
  logStartupStatus,
  prodVerificationToJson,
  renderProdVerification,
  resetStartupLogForTests,
  resolveBot,
  verifyProd,
} from '@opengeo/core/prod';
/** @import { Server } from 'node:http' */
/** @import { AddressInfo } from 'node:net' */
/** @import { ProdProbe } from '@opengeo/core/prod' */

/**
 * `prod test` is verified against a real HTTP server whose responses come from `handleRequest`
 * itself, not from a stubbed fetch. The command's whole job is to describe what a deployed
 * middleware does, so a test that mocked the middleware away would be testing its own fixtures.
 *
 * The knobs below stand in for the things that actually go wrong in a deployment: the middleware
 * not installed, a CDN eating `Vary`, a WAF blocking anything with "bot" in the User-Agent, and a
 * routing list that does not include the bot the user expected.
 */

const HTML = [
  '<!doctype html><html><head><title>Aurora</title></head><body><main>',
  '<h1>Aurora Fieldwork</h1><p>Cold-weather environmental surveys since 2019.</p>',
  '</main></body></html>',
].join('');

const MARKDOWN = '# Aurora Fieldwork\n\nCold-weather environmental surveys since 2019.\n';

const ROBOTS_OPEN = ['User-agent: *', 'Allow: /', '', 'User-agent: ClaudeBot', 'Allow: /', ''].join('\n');

const store = createMemoryStore([
  {
    route: '/',
    title: 'Aurora Fieldwork',
    body: MARKDOWN,
    tokens: 14,
    lastUpdated: '2026-01-01T00:00:00.000Z',
    sourceHash: 'abc123abc123abc1',
  },
]);

/** @type {Server} */
let server;
/** @type {string} */
let site;

// Deployment knobs, reset before every test.
let prodEnabled = true;
/** @type {string | null} */
let robotsBody = ROBOTS_OPEN;
let blockUnknownBots = false;
let stripVary = false;
/** Set to whatever a framework or CDN actually put in Vary, replacing what prod asked for. */
/** @type {string | null} */
let varyOverride = null;
/** @type {string[]} */
let routing = [...DEFAULT_MARKDOWN_ROUTING];

beforeEach(() => {
  prodEnabled = true;
  robotsBody = ROBOTS_OPEN;
  blockUnknownBots = false;
  stripVary = false;
  varyOverride = null;
  routing = [...DEFAULT_MARKDOWN_ROUTING];
});

beforeAll(async () => {
  server = createServer((req, res) => {
    void (async () => {
      const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`;
      const pathname = new URL(url).pathname;

      if (pathname === '/robots.txt') {
        if (robotsBody === null) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('not found');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(robotsBody);
        return;
      }

      const ua = req.headers['user-agent'] ?? '';
      // A WAF rule, not OpenGEO: prod has no code that can produce this.
      if (blockUnknownBots && !identifyBot(ua) && /bot/i.test(ua)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('blocked');
        return;
      }

      if (!prodEnabled) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(HTML);
        return;
      }

      const decision = handleRequest(
        {
          url,
          method: req.method,
          headers: { get: (name) => /** @type {string | undefined} */ (req.headers[name.toLowerCase()]) ?? null },
        },
        { store, markdownRouting: routing },
      );

      if (decision.type === 'passthrough') {
        /** @type {Record<string, string>} */
        const headers = {
          'content-type': 'text/html; charset=utf-8',
          ...decision.headers,
        };
        if (stripVary) delete headers[HEADERS.vary];
        if (varyOverride !== null) headers[HEADERS.vary] = varyOverride;
        res.writeHead(200, headers);
        res.end(HTML);
        return;
      }

      const headers = Object.fromEntries(decision.response.headers.entries());
      if (stripVary) delete headers.vary;
      res.writeHead(decision.response.status, headers);
      res.end(await decision.response.text());
    })();
  });

  await /** @type {Promise<void>} */ (new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)));
  site = `http://127.0.0.1:${/** @type {AddressInfo} */ (server.address()).port}`;
});

afterAll(async () => {
  await /** @type {Promise<void>} */ (new Promise((resolve) => server.close(() => resolve())));
});

/**
 * @param {readonly ProdProbe[]} probes
 * @param {string} id
 * @returns {ProdProbe}
 */
function probeById(probes, id) {
  const found = probes.find((p) => p.id === id);
  if (!found) throw new Error(`no probe ${id}`);
  return found;
}

describe('a healthy deployment', () => {
  it('passes every probe', async () => {
    const result = await verifyProd(site);
    expect(result.installed).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.counts.fail).toBe(0);
    expect(result.counts.warn).toBe(0);
    expect(result.counts.pass).toBe(5);
    expect(result.bot).toBe('ClaudeBot');
  });

  it('proves the routed bot got markdown from its User-Agent alone', async () => {
    const result = await verifyProd(site);
    const routed = probeById(result.probes, 'routed-bot');
    expect(routed.verdict).toBe('pass');
    // The probe sends a browser-typical Accept, so the Accept header cannot be the cause.
    expect(result.probes.find((p) => p.id === 'routed-bot')?.sent.accept).toContain('text/html');
  });

  it('reports lever 2 as off, because blocking is never the default', async () => {
    const result = await verifyProd(site);
    expect(result.robots.found).toBe(true);
    expect(result.robots.blocked).toEqual([]);
    expect(result.robots.notes.join(' ')).toContain('never adds a block you did not ask for');
    expect(result.conflicts).toEqual([]);
  });
});

describe('lever 1 - markdown routing', () => {
  it('an unrecognised bot is served the normal site and is never blocked', async () => {
    const result = await verifyProd(site);
    const unknown = probeById(result.probes, 'unknown-bot');
    expect(unknown.verdict).toBe('pass');
    expect(unknown.status).toBe(200);
    // The point of the probe: the User-Agent it sends must genuinely not be on the list.
    expect(identifyBot(unknown.sent.userAgent)).toBeUndefined();
  });

  it('calls out a host that blocks bots it does not recognise', async () => {
    blockUnknownBots = true;
    const result = await verifyProd(site);
    const unknown = probeById(result.probes, 'unknown-bot');
    expect(unknown.verdict).toBe('fail');
    expect(unknown.status).toBe(403);
    expect(unknown.detail).toContain('opengeo-prod has no blocking code path');
    // A recognised, routed bot is unaffected, which is how the user can tell the two apart.
    expect(probeById(result.probes, 'routed-bot').verdict).toBe('pass');
  });

  it('separates "not on the routing list" from "negotiation is broken"', async () => {
    routing = [];
    const result = await verifyProd(site);
    expect(probeById(result.probes, 'routed-bot').verdict).toBe('fail');
    expect(probeById(result.probes, 'routed-bot').detail).toContain('bots.markdownRouting');
    // Lever 1 being off says nothing about the Accept header, and the report must not conflate them.
    expect(probeById(result.probes, 'accept-markdown').verdict).toBe('pass');
  });

  it('honours --bot', async () => {
    const result = await verifyProd(site, { bot: 'Perplexity-User' });
    expect(result.bot).toBe('Perplexity-User');
    expect(probeById(result.probes, 'routed-bot').verdict).toBe('pass');
  });
});

describe('content negotiation', () => {
  it('warns rather than fails when Vary: Accept is missing', async () => {
    stripVary = true;
    const result = await verifyProd(site);
    const browser = probeById(result.probes, 'browser');
    expect(browser.verdict).toBe('warn');
    expect(browser.reason).toContain('Vary does not include Accept (Vary: absent)');
    // A warning is a finding, not a failure: a CDN can cause it and a user may accept it.
    expect(result.ok).toBe(true);
  });

  it('does not mistake Vary: Accept-Encoding for Vary: Accept', async () => {
    // Next's app router really does overwrite Vary with this. A substring match would call it a
    // pass, which is how a check quietly stops catching anything.
    varyOverride = 'rsc, next-router-state-tree, next-router-prefetch, Accept-Encoding';
    const result = await verifyProd(site);
    const browser = probeById(result.probes, 'browser');
    expect(browser.verdict).toBe('warn');
    expect(browser.reason).toContain('Vary does not include Accept');
  });

  it('accepts Vary: * , which varies on everything including Accept', async () => {
    varyOverride = '*';
    const result = await verifyProd(site);
    expect(probeById(result.probes, 'browser').verdict).toBe('pass');
  });

  it('checks the 406 path', async () => {
    const result = await verifyProd(site);
    const na = probeById(result.probes, 'not-acceptable');
    expect(na.verdict).toBe('pass');
    expect(na.status).toBe(406);
  });

  it('confirms a human still gets the site, with the twin advertised', async () => {
    const result = await verifyProd(site);
    const browser = probeById(result.probes, 'browser');
    expect(browser.verdict).toBe('pass');
    expect(browser.reason).toContain('HTML unchanged');
  });
});

describe('a deployment with no middleware', () => {
  it('says so once, in terms of the header that is missing', async () => {
    prodEnabled = false;
    const result = await verifyProd(site);
    expect(result.installed).toBe(false);
    expect(result.ok).toBe(false);
    for (const id of ['routed-bot', 'accept-markdown', 'not-acceptable']) {
      expect(probeById(result.probes, id).reason).toContain(HEADERS.aeoVersion);
    }
    // The unknown-bot probe still passes: an uninstalled middleware blocks nobody either.
    expect(probeById(result.probes, 'unknown-bot').verdict).toBe('pass');
  });
});

describe('lever 2 - blocking', () => {
  it('reports a missing robots.txt as "nothing is blocked", not as an error', async () => {
    robotsBody = null;
    const result = await verifyProd(site);
    expect(result.robots.found).toBe(false);
    expect(result.robots.notes.join(' ')).toContain('opengeo generate');
    expect(result.ok).toBe(true);
  });

  it('names the bots robots.txt disallows', async () => {
    robotsBody = ['User-agent: GPTBot', 'Disallow: /', '', 'User-agent: *', 'Allow: /'].join('\n');
    const result = await verifyProd(site);
    expect(result.robots.blocked).toContain('GPTBot');
    expect(result.robots.notes.join(' ')).toContain('prod itself never blocks anyone');
  });

  it('flags the two levers contradicting each other on the same bot', async () => {
    robotsBody = ['User-agent: ClaudeBot', 'Disallow: /', '', 'User-agent: *', 'Allow: /'].join('\n');
    const result = await verifyProd(site);
    expect(result.robots.blocked).toContain('ClaudeBot');
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toContain('the two lists currently disagree');
  });
});

describe('--bot resolution', () => {
  it('refuses a robots.txt-only token instead of running a probe that could never pass', () => {
    expect(() => resolveBot('Google-Extended')).toThrow(/never be probed by User-Agent/);
    expect(() => resolveBot('Applebot-Extended')).toThrow(/never be probed by User-Agent/);
  });

  it('lists the routable bots when the name is not one', () => {
    expect(() => resolveBot('SomeBot')).toThrow(/Bots that can be routed by User-Agent/);
  });

  it('matches on name or robots token, case-insensitively', () => {
    expect(resolveBot('gptbot').name).toBe('GPTBot');
    expect(resolveBot('oai-searchbot').name).toBe('OAI-SearchBot');
  });
});

describe('output', () => {
  it('keeps the levers apart in --json', async () => {
    const result = await verifyProd(site);
    const json = JSON.parse(prodVerificationToJson(result));
    expect(Object.keys(json.levers)).toEqual(['routing', 'negotiation', 'blocking']);
    expect(json.levers.routing.setting).toBe('bots.markdownRouting');
    expect(json.levers.blocking.setting).toBe('bots.blocked');
    expect(json.levers.blocking.robots).toBeTruthy();
    // Blocking has no probe of the middleware, because there is nothing in the middleware to probe.
    expect(json.levers.blocking.probes).toBeUndefined();
  });

  it('names both levers in the report, with their config keys', async () => {
    const result = await verifyProd(site);
    const text = renderProdVerification(result);
    expect(text).toContain('Lever 1 - markdown routing (bots.markdownRouting)');
    expect(text).toContain('Lever 2 - blocking (bots.blocked, via robots.txt)');
    expect(text).toContain('prod has no blocking code path');
  });

  it('prints what the deployed server said without letting it drive the terminal', async () => {
    const result = await verifyProd(site);
    result.probes[0].reason = 'served \u001b]0;pwned\u0007\u001b[2K\rtext/html';
    const text = renderProdVerification(result, { verbose: true });
    const ours = text.replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '');
    expect(ours).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(ours).toContain('pwned');
  });

  it('prints a reproducible curl for every probe under --verbose', async () => {
    const result = await verifyProd(site);
    const text = renderProdVerification(result, { verbose: true });
    for (const probe of result.probes) expect(text).toContain(probe.curl);
  });
});

describe('startup logging (§7)', () => {
  /**
   * @returns {string}
   */
  function project() {
    const root = mkdtempSync(join(tmpdir(), 'opengeo-startup-'));
    mkdirSync(join(root, 'public'), { recursive: true });
    return root;
  }

  beforeEach(() => resetStartupLogForTests());

  it('reports what robots.txt currently allows and blocks', () => {
    const root = project();
    writeFileSync(join(root, 'public', 'robots.txt'), ['User-agent: GPTBot', 'Disallow: /'].join('\n'));
    writeFileSync(join(root, 'public', 'llms.txt'), '# llms');
    const status = buildStartupStatus({ root, store });
    const robots = status.files.find((f) => f.name === 'robots.txt');
    expect(robots?.found).toBe(true);
    expect(robots?.detail).toContain('blocking GPTBot');
    expect(status.files.find((f) => f.name === 'sitemap.xml')?.found).toBe(false);
    expect(status.lines.join('\n')).toContain('markdown twins loaded: 1');
  });

  it('tells a user with no generated files exactly which package writes them', () => {
    const status = buildStartupStatus({ root: project(), store: undefined });
    const text = status.lines.join('\n');
    expect(text).toContain('opengeo-generate');
    expect(text).toContain('every request will pass through to the normal site');
  });

  it('logs once per process and never again', () => {
    const root = project();
    /** @type {string[]} */
    const lines = [];
    /** @param {string} line */
    const logger = (line) => lines.push(line);

    const first = logStartupStatus({ root, store, logger });
    expect(first).toBeDefined();
    const before = lines.length;
    expect(before).toBeGreaterThan(0);

    for (let i = 0; i < 20; i += 1) expect(logStartupStatus({ root, store, logger })).toBeUndefined();
    expect(lines.length).toBe(before);
  });

  it('serving requests never writes to the log', () => {
    /** @type {string[]} */
    const written = [];
    const original = console.log;
    console.log = /** @param {...unknown} args */ (...args) => written.push(args.join(' '));
    try {
      for (let i = 0; i < 50; i += 1) {
        handleRequest(
          {
            url: `${site}/`,
            method: 'GET',
            headers: { get: () => (i % 2 === 0 ? 'text/markdown' : null) },
          },
          { store, markdownRouting: DEFAULT_MARKDOWN_ROUTING },
        );
      }
    } finally {
      console.log = original;
    }
    expect(written).toEqual([]);
  });
});
