import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSetup, SetupAbort } from '../src/cli/configure.js';
import { createPrompter, type ChoiceOption, type Prompter } from '../src/cli/prompt.js';
import { ROUTABLE_BOTS } from '../src/shared/bots.js';
import { CONFIG_FILENAME } from '../src/shared/config.js';
import { ENV_FILENAME, KEY_VAR } from '../src/shared/env.js';

/**
 * §11 is the reason this file exists. The guarantee is not "we tell people to gitignore .env", it
 * is "the flow cannot write a key into an un-ignored directory", and the only way to assert an
 * ordering is to observe the disk at the moment the secret is asked for. `onSecret` below does
 * exactly that: it runs inside the prompt, before any key exists.
 *
 * `runSetup` is one function behind two commands, so everything here covers both: `opengeo start`
 * runs it in `first-run` mode, `opengeo settings` in `settings` mode.
 */

interface Script {
  /** Answers for `ask`, in order. An empty entry means "take the default". */
  ask?: string[];
  /** Answers for `choose`, in order, by value. */
  choose?: string[];
  /** Answers for `confirm`, in order. Anything past the end falls back to the prompt's default. */
  confirm?: boolean[];
  secret?: string;
  /** Observed from inside the secret prompt, so it sees the world as it was before the key. */
  onSecret?: () => void;
}

function scripted(script: Script): Prompter & { asked: string[] } {
  const asks = [...(script.ask ?? [])];
  const chooses = [...(script.choose ?? [])];
  const confirms = [...(script.confirm ?? [])];
  const asked: string[] = [];
  return {
    asked,
    async ask(question: string, fallback = '') {
      asked.push(question.trim());
      const next = asks.shift();
      return next === undefined || next === '' ? fallback : next;
    },
    async choose<T extends string>(question: string, options: ChoiceOption<T>[], fallback: T) {
      asked.push(question.trim());
      const next = chooses.shift();
      if (next === undefined) return fallback;
      const match = options.find((option) => option.value === next);
      if (!match) throw new Error(`scripted choice "${next}" is not one of: ${options.map((o) => o.value).join(', ')}`);
      return match.value;
    },
    async secret(question: string) {
      asked.push(question.trim());
      script.onSecret?.();
      return script.secret ?? '';
    },
    async confirm(question: string, fallback: boolean) {
      asked.push(question.trim());
      const next = confirms.shift();
      return next === undefined ? fallback : next;
    },
    close() {},
  };
}

describe('the setup flow behind `opengeo start` and `opengeo settings`', () => {
  let root: string;
  const silent = () => {};

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'opengeo-setup-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe('the key never leaks (§11)', () => {
    it('puts .env in .gitignore before it asks for the key, not after', async () => {
      let gitignoreAtSecretTime: string | undefined;
      const prompter = scripted({
        ask: ['http://localhost:3000'],
        choose: ['all', 'anthropic'],
        secret: 'sk-test-not-a-real-key',
        onSecret: () => {
          const path = join(root, '.gitignore');
          gitignoreAtSecretTime = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
        },
      });

      await runSetup({ root, prompter, out: silent });

      // The assertion is about the snapshot taken mid-prompt, not the end state.
      expect(gitignoreAtSecretTime).toBeDefined();
      expect(gitignoreAtSecretTime).toContain('.env');
      // And nothing had been written yet at that point.
      expect(existsSync(join(root, ENV_FILENAME))).toBe(true);
    });

    it('writes the key to .env and never to the committed config', async () => {
      const prompter = scripted({
        ask: ['http://localhost:3000'],
        choose: ['all', 'anthropic'],
        secret: 'sk-test-not-a-real-key',
      });

      const result = await runSetup({ root, prompter, out: silent });

      const env = readFileSync(join(root, ENV_FILENAME), 'utf8');
      expect(env).toContain(`${KEY_VAR}=sk-test-not-a-real-key`);

      const config = readFileSync(result.configPath, 'utf8');
      expect(config).not.toContain('sk-test-not-a-real-key');
      expect(config).not.toContain(KEY_VAR);
      expect(JSON.stringify(result.config)).not.toContain('sk-test-not-a-real-key');
      expect(result.keyWritten?.provider).toBe('anthropic');
    });

    it('leaves an existing .gitignore rule alone rather than duplicating it', async () => {
      writeFileSync(join(root, '.gitignore'), 'node_modules\n.env\n', 'utf8');
      const prompter = scripted({
        ask: ['http://localhost:3000'],
        choose: ['all', 'openai'],
        secret: 'sk-openai',
      });

      const result = await runSetup({ root, prompter, out: silent });

      const gitignore = readFileSync(join(root, '.gitignore'), 'utf8');
      expect(gitignore.split('\n').filter((line) => line.trim() === '.env')).toHaveLength(1);
      expect(result.keyWritten?.gitignore.alreadyPresent).toBe(true);
    });

    it('touches nothing when the key prompt is answered with an empty string', async () => {
      const prompter = scripted({
        ask: ['http://localhost:3000'],
        choose: ['all', 'anthropic'],
        secret: '',
      });

      const result = await runSetup({ root, prompter, out: silent });

      expect(result.keyWritten).toBeUndefined();
      expect(existsSync(join(root, ENV_FILENAME))).toBe(false);
    });

    it('does not create a .gitignore at all when the key step is skipped', async () => {
      // Someone who never enters a key should not find their repo edited on their behalf.
      const prompter = scripted({ ask: ['http://localhost:3000'], choose: ['all', 'skip'] });

      const result = await runSetup({ root, prompter, out: silent });

      expect(result.keyWritten).toBeUndefined();
      expect(existsSync(join(root, '.gitignore'))).toBe(false);
      expect(existsSync(join(root, ENV_FILENAME))).toBe(false);
    });
  });

  describe('the two bot levers stay separate (§7)', () => {
    it('routes to every known bot on the default choice and blocks nobody', async () => {
      const prompter = scripted({ ask: ['http://localhost:3000'], choose: ['all', 'skip'] });

      const result = await runSetup({ root, prompter, out: silent });

      expect(result.config.bots.markdownRouting).toHaveLength(ROUTABLE_BOTS.length);
      expect(result.config.bots.blocked).toEqual([]);
    });

    it('drops training crawlers from routing when asked for assistants only', async () => {
      const prompter = scripted({ ask: ['http://localhost:3000'], choose: ['assistants', 'skip'] });

      const result = await runSetup({ root, prompter, out: silent });

      const training = ROUTABLE_BOTS.filter((bot) => bot.kind === 'training').map((bot) => bot.name);
      expect(training.length).toBeGreaterThan(0);
      for (const name of training) expect(result.config.bots.markdownRouting).not.toContain(name);
      expect(result.config.bots.markdownRouting.length).toBe(ROUTABLE_BOTS.length - training.length);
    });

    it('can route to nobody, which is not the same as blocking anybody', async () => {
      const prompter = scripted({ ask: ['http://localhost:3000'], choose: ['none', 'skip'] });

      const result = await runSetup({ root, prompter, out: silent });

      expect(result.config.bots.markdownRouting).toEqual([]);
      expect(result.config.bots.blocked).toEqual([]);
    });

    it('never edits a block list the user set by hand', async () => {
      // Setup has no question that adds to bots.blocked, and re-running it must not quietly
      // reset one either.
      writeFileSync(
        join(root, CONFIG_FILENAME),
        JSON.stringify({ site: 'http://old.test', bots: { markdownRouting: [], blocked: ['GPTBot'] } }, null, 2),
        'utf8',
      );
      const prompter = scripted({ ask: ['http://localhost:3000'], choose: ['all', 'skip'] });

      const result = await runSetup({ root, prompter, out: silent });

      expect(result.config.bots.blocked).toEqual(['GPTBot']);
    });
  });

  describe('picking crawlers one by one (the fourth option)', () => {
    it('routes to exactly the crawlers named at the picker', async () => {
      // `none` clears the sheet, then two names go back on it. Both are typed lowercase on purpose:
      // "gptbot" is what a person types, and the picker matches case-insensitively.
      const prompter = scripted({
        ask: ['http://localhost:3000', '', 'none', 'gptbot claudebot', ''],
        choose: ['custom', 'skip'],
      });

      const result = await runSetup({ root, prompter, out: silent });

      expect([...result.config.bots.markdownRouting].sort()).toEqual(['ClaudeBot', 'GPTBot']);
    });

    it('toggles, so naming a crawler twice leaves it off', async () => {
      const prompter = scripted({
        ask: ['http://localhost:3000', '', 'none', 'GPTBot', 'GPTBot', ''],
        choose: ['custom', 'skip'],
      });

      const result = await runSetup({ root, prompter, out: silent });

      expect(result.config.bots.markdownRouting).toEqual([]);
    });

    it('never offers a robots.txt-only token, which could not be routed to anyway', async () => {
      // Google-Extended has no User-Agent of its own, so ticking it would promise something prod
      // cannot deliver. It stays available for the block list, which is a robots.txt list.
      let transcript = '';
      const prompter = scripted({
        ask: ['http://localhost:3000', '', 'Google-Extended', ''],
        choose: ['custom', 'skip'],
      });

      const result = await runSetup({ root, prompter, out: (text) => (transcript += text) });

      expect(transcript).toContain('No crawler called "Google-Extended"');
      expect(result.config.bots.markdownRouting).not.toContain('Google-Extended');
      expect(result.config.bots.markdownRouting).toHaveLength(ROUTABLE_BOTS.length);
    });

    it('adds a crawler OpenGEO has never heard of and routes to it in the same pass', async () => {
      const prompter = scripted({
        ask: [
          'http://localhost:3000',
          '',
          'none',
          'add',
          'AcmeBot',
          'Acme Inc',
          'acmebot, acme-crawler',
          'AcmeBot',
          '',
        ],
        choose: ['custom', 'assistant', 'skip'],
      });

      const result = await runSetup({ root, prompter, out: silent });

      expect(result.addedBots).toHaveLength(1);
      expect(result.addedBots[0]).toMatchObject({
        name: 'AcmeBot',
        vendor: 'Acme Inc',
        uaPatterns: ['acmebot', 'acme-crawler'],
        robotsToken: 'AcmeBot',
        kind: 'assistant',
      });
      // Written into the config, which is the same list prod resolves at boot.
      expect(result.config.bots.custom.map((bot) => bot.name)).toEqual(['AcmeBot']);
      expect(result.config.bots.markdownRouting).toEqual(['AcmeBot']);

      const onDisk = JSON.parse(readFileSync(result.configPath, 'utf8'));
      expect(onDisk.bots.custom[0].uaPatterns).toEqual(['acmebot', 'acme-crawler']);
    });

    it('offers a crawler from a previous run alongside the shipped ones', async () => {
      writeFileSync(
        join(root, CONFIG_FILENAME),
        JSON.stringify({
          site: 'http://localhost:3000',
          bots: { markdownRouting: [], blocked: [], custom: [{ name: 'AcmeBot', uaPatterns: ['acmebot'] }] },
        }),
        'utf8',
      );
      const prompter = scripted({ ask: ['', '', 'AcmeBot', ''], choose: ['custom', 'skip'] });

      const result = await runSetup({ root, prompter, out: silent });

      expect(result.config.bots.markdownRouting).toEqual(['AcmeBot']);
      // Selecting one is not defining one, so nothing new was added.
      expect(result.addedBots).toEqual([]);
      expect(result.config.bots.custom).toHaveLength(1);
    });

    it('refuses to add a name that already belongs to a shipped crawler', async () => {
      let transcript = '';
      const prompter = scripted({
        ask: ['http://localhost:3000', '', 'none', 'add', 'GPTBot', ''],
        choose: ['custom', 'skip'],
      });

      const result = await runSetup({ root, prompter, out: (text) => (transcript += text) });

      expect(transcript).toContain('GPTBot is already on the list');
      expect(result.config.bots.custom).toEqual([]);
    });
  });

  describe('settings mode (§12)', () => {
    /** A configured project, so settings mode has something to edit. */
    function configured(): void {
      writeFileSync(
        join(root, CONFIG_FILENAME),
        JSON.stringify({
          site: 'http://localhost:3000',
          publicDir: 'public',
          bots: { markdownRouting: ROUTABLE_BOTS.map((bot) => bot.name), blocked: [], custom: [] },
        }),
        'utf8',
      );
    }

    it('says so plainly when every answer was a blank line', async () => {
      configured();
      let transcript = '';
      const prompter = scripted({ ask: ['', ''] });

      const result = await runSetup({ root, prompter, mode: 'settings', out: (text) => (transcript += text) });

      expect(transcript).toContain('Nothing changed');
      // No tutorial, and no dashboard pitch: this project already works.
      expect(transcript).not.toContain('Next');
      expect(result.config.site).toBe('http://localhost:3000');
    });

    it('reports what actually changed', async () => {
      configured();
      let transcript = '';
      const prompter = scripted({ ask: ['http://localhost:4000', 'dist'], choose: ['none', 'skip'] });

      await runSetup({ root, prompter, mode: 'settings', out: (text) => (transcript += text) });

      expect(transcript).toContain('http://localhost:3000');
      expect(transcript).toContain('http://localhost:4000');
      expect(transcript).toContain('web root');
      expect(transcript).toContain('markdown routing');
    });

    it('edits the block list, which is the one question a first run never asks', async () => {
      configured();
      const prompter = scripted({ ask: ['', '', 'GPTBot', ''], confirm: [true] });

      const result = await runSetup({ root, prompter, mode: 'settings', out: silent });

      expect(result.config.bots.blocked).toEqual(['GPTBot']);
      // Blocking and routing are separate levers (§7): editing one must not touch the other.
      expect(result.config.bots.markdownRouting).toHaveLength(ROUTABLE_BOTS.length);
    });

    it('leaves the block list alone when the offer is declined', async () => {
      configured();
      const prompter = scripted({ ask: ['', ''], confirm: [false] });

      const result = await runSetup({ root, prompter, mode: 'settings', out: silent });

      expect(result.config.bots.blocked).toEqual([]);
    });

    it('does not put the blocking question in front of a first-run user', async () => {
      const prompter = scripted({ ask: ['http://localhost:3000'], choose: ['all', 'skip'] });

      await runSetup({ root, prompter, out: silent });

      expect(prompter.asked.some((question) => question.startsWith('Edit the block list'))).toBe(false);
    });

    it('offers the current routing as the default rather than re-recommending everyone', async () => {
      writeFileSync(
        join(root, CONFIG_FILENAME),
        JSON.stringify({ site: 'http://localhost:3000', bots: { markdownRouting: [], blocked: [], custom: [] } }),
        'utf8',
      );
      // No scripted choice, so every `choose` answers with the default the flow offered. Pressing
      // Enter through settings must not silently widen a list the user deliberately emptied.
      const prompter = scripted({ ask: ['', ''] });

      const result = await runSetup({ root, prompter, mode: 'settings', out: silent });

      expect(result.config.bots.markdownRouting).toEqual([]);
    });
  });

  describe('answers', () => {
    it('re-asks until the site URL is actually fetchable', async () => {
      const prompter = scripted({ ask: ['not a url', 'localhost:3000', 'http://localhost:3000'], choose: ['all', 'skip'] });

      const result = await runSetup({ root, prompter, out: silent });

      expect(result.config.site).toBe('http://localhost:3000');
      expect(prompter.asked.filter((q) => q.startsWith('Site URL'))).toHaveLength(3);
    });

    it('reports creating a config the first time and updating it the second', async () => {
      const first = await runSetup({
        root,
        prompter: scripted({ ask: ['http://localhost:3000'], choose: ['all', 'skip'] }),
        out: silent,
      });
      expect(first.createdConfig).toBe(true);

      const second = await runSetup({
        root,
        prompter: scripted({ ask: ['http://localhost:4000'], choose: ['all', 'skip'] }),
        out: silent,
      });
      expect(second.createdConfig).toBe(false);
      expect(second.config.site).toBe('http://localhost:4000');
    });

    it('offers the existing config as the defaults on a re-run', async () => {
      await runSetup({
        root,
        prompter: scripted({ ask: ['http://localhost:3000', 'dist'], choose: ['none', 'skip'] }),
        out: silent,
      });

      // Empty answers mean "take the default", so this run should reproduce the first one exactly.
      const again = await runSetup({
        root,
        prompter: scripted({ ask: ['', ''], choose: ['none', 'skip'] }),
        out: silent,
      });

      expect(again.config.site).toBe('http://localhost:3000');
      expect(again.config.publicDir).toBe('dist');
    });

    it('says out loud, on screen, that .gitignore was handled before the key', async () => {
      let transcript = '';
      const prompter = scripted({
        ask: ['http://localhost:3000'],
        choose: ['all', 'anthropic'],
        secret: 'sk-test',
      });

      await runSetup({ root, prompter, out: (text) => (transcript += text) });

      expect(transcript).toContain('.gitignore');
      expect(transcript).toContain('Where your key lives');
      // The transcript is what a screen recording would capture. The key must not be in it.
      expect(transcript).not.toContain('sk-test');
    });

    it('does not claim a key exists when none was written', async () => {
      let transcript = '';
      await runSetup({
        root,
        prompter: scripted({ ask: ['http://localhost:3000'], choose: ['all', 'skip'] }),
        out: (text) => (transcript += text),
      });

      expect(transcript).toContain('nothing there yet');
      expect(transcript).not.toContain(`Wrote ${KEY_VAR}`);
    });
  });
});

describe('when the input stream ends mid-flow', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'opengeo-setup-eof-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A prompter backed by a stream that ends immediately, which is what Ctrl-D looks like. */
  function endedPrompter(): Prompter {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const prompter = createPrompter({ input, output });
    input.end();
    return prompter;
  }

  it('answers from defaults instead of hanging on an unsettled question', async () => {
    const prompter = endedPrompter();
    // Give readline a tick to notice the closed stream.
    await new Promise((resolve) => setImmediate(resolve));

    const answer = await Promise.race([
      prompter.ask('Site URL', 'http://localhost:3000'),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('ask() hung on EOF')), 1000)),
    ]);
    prompter.close();

    expect(answer).toBe('http://localhost:3000');
  });

  it('stops with a message rather than looping forever on an unanswerable URL prompt', async () => {
    // The stored default is not a URL, so no amount of re-asking an ended stream can fix it.
    writeFileSync(join(root, CONFIG_FILENAME), JSON.stringify({ site: 'not-a-url' }), 'utf8');
    const prompter = endedPrompter();
    await new Promise((resolve) => setImmediate(resolve));

    await expect(runSetup({ root, prompter, out: () => {} })).rejects.toBeInstanceOf(SetupAbort);
    prompter.close();
    expect(existsSync(join(root, ENV_FILENAME))).toBe(false);
  });
});

describe('the prompter', () => {
  it('masks a secret so the typed characters never reach the output stream', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = '';
    output.on('data', (chunk: Buffer) => (written += chunk.toString()));

    const prompter = createPrompter({ input, output });
    const pending = prompter.secret('key:');
    // readline needs a tick to attach before keystrokes mean anything.
    await new Promise((resolve) => setImmediate(resolve));
    input.write('hunter2\n');
    const value = await pending;
    prompter.close();

    expect(value).toBe('hunter2');
    expect(written).not.toContain('hunter2');
    expect(written).toContain('*');
  });

  it('answers from defaults without reading input when auto-accepting', async () => {
    const prompter = createPrompter({ autoAccept: true });
    expect(await prompter.ask('Site URL', 'http://localhost:3000')).toBe('http://localhost:3000');
    expect(await prompter.choose('Route to', [{ value: 'all', label: 'all' }], 'all')).toBe('all');
    expect(await prompter.secret('key:')).toBe('');
    expect(await prompter.confirm('sure?', true)).toBe(true);
    prompter.close();
  });
});
