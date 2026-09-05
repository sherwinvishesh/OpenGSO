import { JSDOM } from 'jsdom';

/**
 * HTML -> Markdown extraction, the free/algorithmic tier (idea.md §6).
 *
 * Hand-written rather than pulled from a converter library for two reasons: it keeps core
 * dependency-light (only jsdom), and the conversion needs OpenGEO-specific behaviour a general
 * converter won't give us - main-content selection, noise stripping, absolute link resolution, and
 * a word count the low-content warning depends on.
 *
 * Scripts are NOT executed here. That is the §18-step-8 boundary: see TODO-csr-jsdom.md.
 * The shape-aware handling of non-MDX SSR output is §18 step 5: see TODO-ssr-extraction.md.
 */

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/** Removed everywhere: never carries page content, always costs tokens. */
const ALWAYS_STRIP = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'iframe',
  'object',
  'embed',
  'canvas',
  'form',
  'input',
  'select',
  'textarea',
  'button',
  '[aria-hidden="true"]',
  '[hidden]',
  '.sr-only',
  '.visually-hidden',
  '.screen-reader-text',
  'nextjs-portal',
].join(',');

/**
 * Removed only when we had to fall back to <body>, i.e. the page gave us no semantic main region.
 * Inside a real <main>/<article> these tags usually hold real content (an article's own header),
 * so stripping them unconditionally would delete the title of every well-marked-up page.
 */
const CHROME_STRIP = [
  'nav',
  'header',
  'footer',
  'aside',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[role="complementary"]',
].join(',');

/** Tried in order. The first match wins. */
const MAIN_SELECTORS = [
  'main',
  '[role="main"]',
  'article',
  '#main-content',
  '#content',
  '#main',
  '.post-content',
  '.entry-content',
  '.prose',
  '.content',
];

export interface ExtractedPage {
  title: string;
  description?: string;
  markdown: string;
  wordCount: number;
  /** Which selector supplied the content, so users can debug a bad extraction. */
  contentRoot: string;
  warnings: string[];
  /** Raw JSON-LD blocks found in the document, reused by test's schema check. */
  jsonLd: unknown[];
}

export interface ExtractOptions {
  /** Absolute URL of the page, used to resolve relative links and images. */
  url: string;
  /** Below this, the page gets an explicit low-content warning (§17 CSR ceiling). */
  minWords?: number;
}

export function extractPage(html: string, options: ExtractOptions): ExtractedPage {
  const dom = new JSDOM(html, { url: options.url });
  const doc = dom.window.document;
  const warnings: string[] = [];
  const jsonLd = readJsonLd(doc);
  for (const error of jsonLd.errors) {
    warnings.push(`A JSON-LD block on this page does not parse and was ignored: ${error}`);
  }

  const { root, selector } = pickContentRoot(doc);
  for (const node of Array.from(root.querySelectorAll(ALWAYS_STRIP))) node.remove();
  if (selector === 'body') {
    for (const node of Array.from(root.querySelectorAll(CHROME_STRIP))) node.remove();
    warnings.push(
      'No <main>, <article> or [role="main"] found - fell back to <body> and stripped nav/header/footer. Adding a <main> landmark gives a cleaner twin.',
    );
  }

  const title = pickTitle(doc, root);
  const description = pickDescription(doc);
  const blocks = renderChildren(root, { baseUrl: options.url });
  let markdown = blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();

  // The <h1> normally survives inside the content root; only prepend a heading when it didn't, so
  // a well-marked-up page never ends up with its title twice.
  if (title && !/^#\s/m.test(markdown.split('\n')[0] ?? '')) {
    markdown = `# ${title}\n\n${markdown}`.trim();
  }

  const wordCount = markdown.split(/\s+/).filter(Boolean).length;
  const minWords = options.minWords ?? 40;
  if (wordCount < minWords) {
    warnings.push(
      `Only ${wordCount} words extracted (threshold ${minWords}). If this page renders its content with JavaScript, OpenGEO cannot see it yet - see TODO-csr-jsdom.md.`,
    );
  }

  dom.window.close();
  return { title, description, markdown, wordCount, contentRoot: selector, warnings, jsonLd: jsonLd.blocks };
}

function pickContentRoot(doc: Document): { root: Element; selector: string } {
  for (const selector of MAIN_SELECTORS) {
    const found = doc.querySelector(selector);
    // A short-but-real page is still a page: only skip a landmark that is essentially empty, which
    // is what an unrendered SPA shell (`<main></main>`) looks like.
    if (found && textLength(found) >= 40) return { root: found, selector };
  }
  return { root: doc.body ?? doc.documentElement, selector: 'body' };
}

function textLength(el: Element): number {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim().length;
}

function pickTitle(doc: Document, root: Element): string {
  const h1 = root.querySelector('h1');
  if (h1?.textContent?.trim()) return clean(h1.textContent);
  const ogTitle = doc.querySelector('meta[property="og:title"]')?.getAttribute('content');
  if (ogTitle?.trim()) return clean(ogTitle);
  const docTitle = doc.querySelector('title')?.textContent;
  if (docTitle?.trim()) return clean(docTitle);
  return 'Untitled';
}

function pickDescription(doc: Document): string | undefined {
  const meta =
    doc.querySelector('meta[name="description"]')?.getAttribute('content') ??
    doc.querySelector('meta[property="og:description"]')?.getAttribute('content');
  const value = meta?.trim();
  return value ? clean(value) : undefined;
}

export interface JsonLdScan {
  /** Blocks that actually parsed. A broken block is reported, never passed on as if it were data. */
  blocks: unknown[];
  errors: string[];
}

export function readJsonLd(doc: Document): JsonLdScan {
  const blocks: unknown[] = [];
  const errors: string[] = [];
  for (const node of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    const raw = node.textContent?.trim();
    if (!raw) continue;
    try {
      blocks.push(JSON.parse(raw));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { blocks, errors };
}

interface RenderContext {
  baseUrl: string;
}

/** Render an element's children into a list of block-level markdown chunks. */
function renderChildren(parent: Element, ctx: RenderContext): string[] {
  const blocks: string[] = [];
  let inlineBuffer = '';

  const flush = () => {
    const text = collapse(inlineBuffer);
    if (text) blocks.push(text);
    inlineBuffer = '';
  };

  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === TEXT_NODE) {
      inlineBuffer += escapeText(child.textContent ?? '');
      continue;
    }
    if (child.nodeType !== ELEMENT_NODE) continue;
    const el = child as Element;
    if (isInline(el.tagName.toLowerCase())) {
      inlineBuffer += renderInline(el, ctx);
      continue;
    }
    flush();
    blocks.push(...renderBlock(el, ctx));
  }
  flush();
  return blocks.filter((b) => b.trim().length > 0);
}

const INLINE_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'i', 'img',
  'ins', 'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u',
  'var', 'wbr', 'label',
]);

function isInline(tag: string): boolean {
  return INLINE_TAGS.has(tag);
}

function renderBlock(el: Element, ctx: RenderContext): string[] {
  const tag = el.tagName.toLowerCase();

  switch (tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      const level = Number(tag[1]);
      const text = collapse(renderInlineChildren(el, ctx));
      return text ? [`${'#'.repeat(level)} ${text}`] : [];
    }
    case 'p':
    case 'address':
    case 'figcaption':
    case 'summary': {
      const text = collapse(renderInlineChildren(el, ctx));
      return text ? [text] : [];
    }
    case 'br':
      return [];
    case 'hr':
      return ['---'];
    case 'pre':
      return [renderPre(el)];
    case 'blockquote': {
      const inner = renderChildren(el, ctx).join('\n\n');
      if (!inner.trim()) return [];
      return [inner.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n')];
    }
    case 'ul':
    case 'ol':
      return [renderList(el, ctx, 0)];
    case 'dl':
      return [renderDefinitionList(el, ctx)];
    case 'table':
      return [renderTable(el, ctx)];
    case 'li':
      // A stray <li> outside a list; render as a bullet rather than dropping it.
      return [`- ${collapse(renderInlineChildren(el, ctx))}`];
    default:
      return renderChildren(el, ctx);
  }
}

function renderPre(el: Element): string {
  const code = el.querySelector('code');
  const source = code ?? el;
  const language = detectLanguage(source) ?? detectLanguage(el) ?? '';
  const text = (source.textContent ?? '').replace(/\n+$/, '');
  const fence = text.includes('```') ? '````' : '```';
  return `${fence}${language}\n${text}\n${fence}`;
}

function detectLanguage(el: Element): string | undefined {
  const className = el.getAttribute('class') ?? '';
  const match = /(?:^|\s)(?:language|lang)-([a-z0-9+#-]+)/i.exec(className);
  return match?.[1]?.toLowerCase();
}

function renderList(el: Element, ctx: RenderContext, depth: number): string {
  const ordered = el.tagName.toLowerCase() === 'ol';
  const startAttr = Number(el.getAttribute('start') ?? '1');
  const start = Number.isFinite(startAttr) ? startAttr : 1;
  const indent = '  '.repeat(depth);
  const lines: string[] = [];
  let index = start;

  for (const child of Array.from(el.children)) {
    if (child.tagName.toLowerCase() !== 'li') continue;
    const marker = ordered ? `${index}. ` : '- ';
    index += 1;

    const nested: string[] = [];
    const inlineParts: string[] = [];
    for (const node of Array.from(child.childNodes)) {
      if (node.nodeType === TEXT_NODE) {
        inlineParts.push(escapeText(node.textContent ?? ''));
        continue;
      }
      if (node.nodeType !== ELEMENT_NODE) continue;
      const sub = node as Element;
      const subTag = sub.tagName.toLowerCase();
      if (subTag === 'ul' || subTag === 'ol') {
        nested.push(renderList(sub, ctx, depth + 1));
      } else if (isInline(subTag)) {
        inlineParts.push(renderInline(sub, ctx));
      } else {
        const rendered = renderBlock(sub, ctx).join('\n\n');
        if (rendered) nested.push(indentBlock(rendered, depth + 1));
      }
    }

    const head = collapse(inlineParts.join(''));
    lines.push(`${indent}${marker}${head}`.trimEnd());
    for (const block of nested) if (block.trim()) lines.push(block);
  }
  return lines.join('\n');
}

function indentBlock(text: string, depth: number): string {
  const indent = '  '.repeat(depth);
  return text.split('\n').map((line) => (line ? `${indent}${line}` : line)).join('\n');
}

function renderDefinitionList(el: Element, ctx: RenderContext): string {
  const lines: string[] = [];
  for (const child of Array.from(el.children)) {
    const tag = child.tagName.toLowerCase();
    const text = collapse(renderInlineChildren(child, ctx));
    if (!text) continue;
    if (tag === 'dt') lines.push(`**${text}**`);
    else if (tag === 'dd') lines.push(`: ${text}`);
  }
  return lines.join('\n');
}

function renderTable(el: Element, ctx: RenderContext): string {
  const rows: string[][] = [];
  for (const tr of Array.from(el.querySelectorAll('tr'))) {
    const cells = Array.from(tr.children)
      .filter((cell) => ['td', 'th'].includes(cell.tagName.toLowerCase()))
      .map((cell) => collapse(renderInlineChildren(cell, ctx)).replace(/\|/g, '\\|'));
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length === 0) return '';

  const hasHeader = Boolean(el.querySelector('thead th, thead td, tr > th'));
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (row: string[]) => {
    const filled = [...row];
    while (filled.length < width) filled.push('');
    return `| ${filled.join(' | ')} |`;
  };

  const header = hasHeader ? rows[0]! : Array.from({ length: width }, () => '');
  const body = hasHeader ? rows.slice(1) : rows;
  const separator = `| ${Array.from({ length: width }, () => '---').join(' | ')} |`;
  return [pad(header), separator, ...body.map(pad)].join('\n');
}

function renderInlineChildren(el: Element, ctx: RenderContext): string {
  let out = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === TEXT_NODE) out += escapeText(node.textContent ?? '');
    else if (node.nodeType === ELEMENT_NODE) {
      const child = node as Element;
      out += isInline(child.tagName.toLowerCase())
        ? renderInline(child, ctx)
        : renderBlock(child, ctx).join(' ');
    }
  }
  return out;
}

function renderInline(el: Element, ctx: RenderContext): string {
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case 'br':
      return '\n';
    case 'wbr':
      return '';
    case 'img': {
      const alt = (el.getAttribute('alt') ?? '').trim();
      const src = absolute(el.getAttribute('src'), ctx.baseUrl);
      if (!src) return alt;
      return `![${alt}](${src})`;
    }
    case 'a': {
      const inner = collapse(renderInlineChildren(el, ctx));
      const href = absolute(el.getAttribute('href'), ctx.baseUrl);
      if (!href || !inner) return inner;
      if (href.startsWith('javascript:')) return inner;
      return `[${inner}](${href})`;
    }
    case 'code': {
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!text) return '';
      const fence = text.includes('`') ? '``' : '`';
      const padding = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
      return `${fence}${padding}${text}${padding}${fence}`;
    }
    case 'strong':
    case 'b': {
      const text = collapse(renderInlineChildren(el, ctx));
      return text ? `**${text}**` : '';
    }
    case 'em':
    case 'i':
    case 'cite':
    case 'dfn':
    case 'var': {
      const text = collapse(renderInlineChildren(el, ctx));
      return text ? `*${text}*` : '';
    }
    case 'del':
    case 's': {
      const text = collapse(renderInlineChildren(el, ctx));
      return text ? `~~${text}~~` : '';
    }
    default:
      return renderInlineChildren(el, ctx);
  }
}

function absolute(href: string | null, baseUrl: string): string | undefined {
  if (!href) return undefined;
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('#')) return undefined;
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return undefined;
  }
}

/**
 * Escape only what would actually change the meaning of the rendered markdown. Over-escaping makes
 * the twin harder for a human to read and inflates the token count for no benefit.
 */
function escapeText(text: string): string {
  return text
    .replace(/([\\`*_[\]])/g, '\\$1')
    .replace(/^(\s*)([-+#>])/gm, '$1\\$2');
}

function collapse(text: string): string {
  return text.replace(/[ \t]*\n[ \t]*/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
}

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
