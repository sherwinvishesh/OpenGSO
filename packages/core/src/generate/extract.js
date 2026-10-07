import { JSDOM } from 'jsdom';

/**
 * HTML -> Markdown extraction, the free/algorithmic tier (§6).
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

/**
 * @typedef {object} ExtractedPage
 * @property {string} title
 * @property {string} [description]
 * @property {string} markdown
 * @property {number} wordCount
 * @property {string} contentRoot Which selector supplied the content, so users can debug a bad
 *   extraction.
 * @property {string[]} warnings
 * @property {unknown[]} jsonLd Raw JSON-LD blocks found in the document, reused by test's schema
 *   check.
 */

/**
 * @typedef {object} ExtractOptions
 * @property {string} url Absolute URL of the page, used to resolve relative links and images.
 * @property {number} [minWords] Below this, the page gets an explicit low-content warning (§17 CSR
 *   ceiling).
 */

/**
 * @param {string} html
 * @param {ExtractOptions} options
 * @returns {ExtractedPage}
 */
export function extractPage(html, options) {
  const dom = new JSDOM(html, { url: options.url });
  const doc = dom.window.document;
  /** @type {string[]} */
  const warnings = [];
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
  // A <form> is usually a search box or a signup and goes, but ASP.NET WebForms and some CMSs wrap
  // the whole page in one, and stripping that left a twin holding only the title. A form that holds
  // most of the remaining text is the page; its controls are already gone.
  const rootText = textLength(root);
  for (const form of Array.from(root.querySelectorAll('form'))) {
    if (textLength(form) <= rootText / 2) form.remove();
  }

  const title = pickTitle(doc, root);
  const description = pickDescription(doc);
  const blocks = renderChildren(root, { baseUrl: options.url });
  let markdown = blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();

  // The <h1> normally survives inside the content root; only prepend a heading when it didn't, so
  // a well-marked-up page never ends up with its title twice. Asked of the DOM rather than of the
  // first markdown line, because a breadcrumb above the <h1> is common and is not a missing title.
  const titleFromRoot = Boolean(root.querySelector('h1')?.textContent?.trim());
  if (title && !titleFromRoot && !/^#\s/m.test(markdown.split('\n')[0] ?? '')) {
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

/**
 * @param {Document} doc
 * @returns {{ root: Element; selector: string }}
 */
function pickContentRoot(doc) {
  for (const selector of MAIN_SELECTORS) {
    const found = selector === 'article' ? gatherArticles(doc) : doc.querySelector(selector);
    // A short-but-real page is still a page: only skip a landmark that is essentially empty, which
    // is what an unrendered SPA shell (`<main></main>`) looks like.
    if (found && textLength(found) >= 40) return { root: found, selector };
  }
  return { root: doc.body ?? doc.documentElement, selector: 'body' };
}

/**
 * A listing page with no <main> is often a run of sibling <article>s, and taking only the first
 * would publish a twin of one post. Their common ancestor would drag the chrome back in, so the
 * top-level ones are copied into a detached container instead. Nested articles (a comment inside a
 * post) come along with their parent. Copies, so a container that fails the emptiness floor leaves
 * the document whole for the selectors after it.
 *
 * @param {Document} doc
 * @returns {Element | null}
 */
function gatherArticles(doc) {
  const topLevel = Array.from(doc.querySelectorAll('article')).filter(
    (article) => !article.parentElement?.closest('article'),
  );
  if (topLevel.length <= 1) return topLevel[0] ?? null;
  const container = doc.createElement('div');
  for (const article of topLevel) container.append(article.cloneNode(true));
  return container;
}

/**
 * @param {Element} el
 * @returns {number}
 */
function textLength(el) {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim().length;
}

/**
 * @param {Document} doc
 * @param {Element} root
 * @returns {string}
 */
function pickTitle(doc, root) {
  const h1 = root.querySelector('h1');
  if (h1?.textContent?.trim()) return clean(h1.textContent);
  const ogTitle = doc.querySelector('meta[property="og:title"]')?.getAttribute('content');
  if (ogTitle?.trim()) return clean(ogTitle);
  const docTitle = doc.querySelector('title')?.textContent;
  if (docTitle?.trim()) return clean(docTitle);
  return 'Untitled';
}

/**
 * @param {Document} doc
 * @returns {string | undefined}
 */
function pickDescription(doc) {
  const meta =
    doc.querySelector('meta[name="description"]')?.getAttribute('content') ??
    doc.querySelector('meta[property="og:description"]')?.getAttribute('content');
  const value = meta?.trim();
  return value ? clean(value) : undefined;
}

/**
 * @typedef {object} JsonLdScan
 * @property {unknown[]} blocks Blocks that actually parsed. A broken block is reported, never passed
 *   on as if it were data.
 * @property {string[]} errors
 */

/**
 * @param {Document} doc
 * @returns {JsonLdScan}
 */
export function readJsonLd(doc) {
  /** @type {unknown[]} */
  const blocks = [];
  /** @type {string[]} */
  const errors = [];
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

/**
 * @typedef {object} RenderContext
 * @property {string} baseUrl
 * @property {boolean} [inCell] Rendering inside a table cell, where a nested table must be flattened.
 */

/**
 * Render an element's children into a list of block-level markdown chunks.
 *
 * @param {Element} parent
 * @param {RenderContext} ctx
 * @returns {string[]}
 */
function renderChildren(parent, ctx) {
  /** @type {string[]} */
  const blocks = [];
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
    const el = /** @type {Element} */ (child);
    if (isInline(el.tagName.toLowerCase()) && !isBlockLink(el)) {
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

/**
 * @param {string} tag
 * @returns {boolean}
 */
function isInline(tag) {
  return INLINE_TAGS.has(tag);
}

const BLOCK_DESCENDANTS = [
  'address', 'article', 'aside', 'blockquote', 'dd', 'div', 'dl', 'dt', 'figure', 'figcaption',
  'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p',
  'pre', 'section', 'table', 'ul',
].join(',');

/**
 * An <a> wrapped around a whole card. Rendered inline, its heading and paragraphs collapse into one
 * link text with a literal `###` in it, which is neither a link nor a heading to a reader.
 *
 * @param {Element} el
 * @returns {boolean}
 */
function isBlockLink(el) {
  return el.tagName.toLowerCase() === 'a' && el.querySelector(BLOCK_DESCENDANTS) !== null;
}

/**
 * Render a card link as its own blocks, and hang the destination on the first single-line heading.
 * With no heading to carry it, the destination follows as an autolink so it is not lost.
 *
 * @param {Element} el
 * @param {RenderContext} ctx
 * @returns {string[]}
 */
function renderBlockLink(el, ctx) {
  const blocks = renderChildren(el, ctx);
  const href = absolute(el.getAttribute('href'), ctx.baseUrl);
  if (!href || href.startsWith('javascript:') || blocks.length === 0) return blocks;
  const headingAt = blocks.findIndex((block) => /^#{1,6} [^\n]+$/.test(block));
  if (headingAt >= 0) {
    const heading = /** @type {string} */ (blocks[headingAt]);
    blocks[headingAt] = heading.replace(/^(#{1,6} )(.*)$/, (_, marker, text) => `${marker}[${text}](${href})`);
    return blocks;
  }
  return [...blocks, `<${href}>`];
}

/**
 * @param {Element} el
 * @param {RenderContext} ctx
 * @returns {string[]}
 */
function renderBlock(el, ctx) {
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
    case 'a':
      return renderBlockLink(el, ctx);
    default:
      return renderChildren(el, ctx);
  }
}

/**
 * @param {Element} el
 * @returns {string}
 */
function renderPre(el) {
  const code = el.querySelector('code');
  const source = code ?? el;
  const language = detectLanguage(source) ?? detectLanguage(el) ?? '';
  const text = (source.textContent ?? '').replace(/\n+$/, '');
  const fence = text.includes('```') ? '````' : '```';
  return `${fence}${language}\n${text}\n${fence}`;
}

/**
 * @param {Element} el
 * @returns {string | undefined}
 */
function detectLanguage(el) {
  const className = el.getAttribute('class') ?? '';
  const match = /(?:^|\s)(?:language|lang)-([a-z0-9+#-]+)/i.exec(className);
  return match?.[1]?.toLowerCase();
}

/**
 * @param {Element} el
 * @param {RenderContext} ctx
 * @param {number} depth
 * @returns {string}
 */
function renderList(el, ctx, depth) {
  const ordered = el.tagName.toLowerCase() === 'ol';
  const startAttr = Number(el.getAttribute('start') ?? '1');
  const start = Number.isFinite(startAttr) ? startAttr : 1;
  const indent = '  '.repeat(depth);
  /** @type {string[]} */
  const lines = [];
  let index = start;

  for (const child of Array.from(el.children)) {
    if (child.tagName.toLowerCase() !== 'li') continue;
    const marker = ordered ? `${index}. ` : '- ';
    index += 1;

    /** @type {string[]} */
    const nested = [];
    /** @type {string[]} */
    const inlineParts = [];
    for (const node of Array.from(child.childNodes)) {
      if (node.nodeType === TEXT_NODE) {
        inlineParts.push(escapeText(node.textContent ?? ''));
        continue;
      }
      if (node.nodeType !== ELEMENT_NODE) continue;
      const sub = /** @type {Element} */ (node);
      const subTag = sub.tagName.toLowerCase();
      if (subTag === 'ul' || subTag === 'ol') {
        nested.push(renderList(sub, ctx, depth + 1));
      } else if (isInline(subTag) && !isBlockLink(sub)) {
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

/**
 * @param {string} text
 * @param {number} depth
 * @returns {string}
 */
function indentBlock(text, depth) {
  const indent = '  '.repeat(depth);
  return text.split('\n').map((line) => (line ? `${indent}${line}` : line)).join('\n');
}

/**
 * @param {Element} el
 * @param {RenderContext} ctx
 * @returns {string}
 */
function renderDefinitionList(el, ctx) {
  /** @type {string[]} */
  const lines = [];
  for (const child of Array.from(el.children)) {
    const tag = child.tagName.toLowerCase();
    const text = collapse(renderInlineChildren(child, ctx));
    if (!text) continue;
    if (tag === 'dt') lines.push(`**${text}**`);
    else if (tag === 'dd') lines.push(`: ${text}`);
  }
  return lines.join('\n');
}

/**
 * @param {Element} el
 * @param {RenderContext} ctx
 * @returns {string}
 */
function renderTable(el, ctx) {
  // A GFM cell cannot hold a table, so one nested inside a cell is written as lines of
  // comma-separated values, which the outer cell then joins with <br>.
  if (ctx.inCell) {
    return ownRows(el)
      .map((tr) => tr.map((cell) => collapse(renderInlineChildren(cell, ctx))).filter(Boolean).join(', '))
      .filter(Boolean)
      .join('\n');
  }
  const cellCtx = { ...ctx, inCell: true };
  /** @type {string[][]} */
  const rows = [];
  for (const tr of ownRows(el)) {
    const cells = tr
      // A GFM row is one line, so a line break inside a cell (a <br>, a list) has to stay HTML.
      .map((cell) => collapse(renderInlineChildren(cell, cellCtx)).replace(/\|/g, '\\|').replace(/\n/g, '<br>'));
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length === 0) return '';

  // Asked of this table's own rows: a <th> in a table nested inside a cell says nothing about this one.
  const hasHeader = Array.from(/** @type {HTMLTableElement} */ (el).rows).some(
    (tr) => tr.parentElement?.tagName.toLowerCase() === 'thead' || Array.from(tr.children).some((cell) => cell.tagName.toLowerCase() === 'th'),
  );
  const width = Math.max(...rows.map((r) => r.length));
  /** @param {string[]} row */
  const pad = (row) => {
    const filled = [...row];
    while (filled.length < width) filled.push('');
    return `| ${filled.join(' | ')} |`;
  };

  const header = hasHeader ? rows[0] : Array.from({ length: width }, () => '');
  const body = hasHeader ? rows.slice(1) : rows;
  const separator = `| ${Array.from({ length: width }, () => '---').join(' | ')} |`;
  return [pad(header), separator, ...body.map(pad)].join('\n');
}

/**
 * The cells of a table's own rows. `querySelectorAll('tr')` would also return the rows of every
 * table nested inside a cell and splice them into this one.
 *
 * @param {Element} el
 * @returns {Element[][]}
 */
function ownRows(el) {
  return Array.from(/** @type {HTMLTableElement} */ (el).rows).map((tr) =>
    Array.from(tr.children).filter((cell) => ['td', 'th'].includes(cell.tagName.toLowerCase())),
  );
}

/**
 * @param {Element} el
 * @param {RenderContext} ctx
 * @returns {string}
 */
function renderInlineChildren(el, ctx) {
  let out = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === TEXT_NODE) out += escapeText(node.textContent ?? '');
    else if (node.nodeType === ELEMENT_NODE) {
      const child = /** @type {Element} */ (node);
      out += isInline(child.tagName.toLowerCase())
        ? renderInline(child, ctx)
        : renderBlock(child, ctx).join(' ');
    }
  }
  return out;
}

/**
 * @param {Element} el
 * @param {RenderContext} ctx
 * @returns {string}
 */
function renderInline(el, ctx) {
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case 'br':
      return '\n';
    case 'wbr':
      return '';
    case 'img': {
      // An attribute is page text like any other, and unescaped it could close the image early.
      const alt = escapeText(clean(el.getAttribute('alt') ?? ''));
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

/**
 * @param {string | null} href
 * @param {string} baseUrl
 * @returns {string | undefined}
 */
function absolute(href, baseUrl) {
  if (!href) return undefined;
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('#')) return undefined;
  try {
    // The URL serialiser encodes spaces and angle brackets but not parentheses, and a `)` would
    // end the link destination early and let the rest of the href read as markdown.
    return new URL(trimmed, baseUrl).toString().replace(/\(/g, '%28').replace(/\)/g, '%29');
  } catch {
    return undefined;
  }
}

/**
 * Escape only what would actually change the meaning of the rendered markdown. Over-escaping makes
 * the twin harder for a human to read and inflates the token count for no benefit.
 *
 * @param {string} text
 * @returns {string}
 */
function escapeText(text) {
  return text
    .replace(/([\\`*_[\]])/g, '\\$1')
    // Only a `<` that could open a tag, a comment or an autolink. "2 < 3" means what it says.
    .replace(/<(?=[A-Za-z/!?])/g, '\\<')
    .replace(/^(\s*)([-+#>])/gm, '$1\\$2');
}

/**
 * @param {string} text
 * @returns {string}
 */
function collapse(text) {
  return text.replace(/[ \t]*\n[ \t]*/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * @param {string} text
 * @returns {string}
 */
function clean(text) {
  return text.replace(/\s+/g, ' ').trim();
}
