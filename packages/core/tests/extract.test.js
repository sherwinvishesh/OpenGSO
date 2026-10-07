import { describe, expect, it } from 'vitest';
import { extractPage } from '@opengeo/core/generate';

/**
 * @param {string} body
 * @param {string} [head]
 */
const page = (body, head = '') => `<!doctype html><html><head><title>Test page</title>${head}</head><body>${body}</body></html>`;

describe('extractPage', () => {
  it('prefers <main> over the surrounding chrome', () => {
    const html = page(`
      <nav><a href="/">Home</a><a href="/about">About</a></nav>
      <main><h1>Resume</h1><p>Shipped 4 projects in 2024, including a $12,500 contract signed on 3 March 2024.</p></main>
      <footer>© 2024</footer>
    `);
    const result = extractPage(html, { url: 'https://example.com/resume' });
    expect(result.contentRoot).toBe('main');
    expect(result.markdown).toContain('# Resume');
    expect(result.markdown).toContain('Shipped 4 projects in 2024, including a $12,500 contract signed on 3 March 2024.');
    expect(result.markdown).not.toContain('© 2024');
  });

  it('strips scripts, styles and aria-hidden decoration wherever they appear', () => {
    const html = page(`
      <main>
        <script>console.log('never in output')</script>
        <style>.x{color:red}</style>
        <span aria-hidden="true">decorative</span>
        <p>Real text.</p>
      </main>
    `);
    const { markdown } = extractPage(html, { url: 'https://example.com/' });
    expect(markdown).toContain('Real text.');
    expect(markdown).not.toContain('never in output');
    expect(markdown).not.toContain('color:red');
    expect(markdown).not.toContain('decorative');
  });

  it('drops nav, header, footer and aside only when it has to fall back to <body>', () => {
    const html = page(`
      <header>Site name</header>
      <nav><a href="/about">About</a></nav>
      <p>Body level content that is long enough to be treated as the real thing by the extractor.</p>
      <footer>Footer text</footer>
    `);
    const result = extractPage(html, { url: 'https://example.com/' });
    expect(result.contentRoot).toBe('body');
    expect(result.markdown).toContain('Body level content');
    expect(result.markdown).not.toContain('Footer text');
    expect(result.markdown).not.toContain('Site name');
  });

  it('renders headings, nested lists, code, tables and links', () => {
    const html = page(`
      <main>
        <h1>Title</h1>
        <h2>Section</h2>
        <ul><li>One<ul><li>Nested</li></ul></li><li>Two</li></ul>
        <ol><li>First</li><li>Second</li></ol>
        <pre><code class="language-ts">const x: number = 1;</code></pre>
        <blockquote><p>Quoted.</p></blockquote>
        <table><thead><tr><th>Year</th><th>Role</th></tr></thead><tbody><tr><td>2024</td><td>Engineer</td></tr></tbody></table>
        <p>See <a href="/about">about</a> and <strong>bold</strong> and <em>italic</em> and <code>inline</code>.</p>
        <hr>
      </main>
    `);
    const { markdown } = extractPage(html, { url: 'https://example.com/' });
    expect(markdown).toContain('# Title');
    expect(markdown).toContain('## Section');
    expect(markdown).toContain('- One');
    expect(markdown).toContain('  - Nested');
    expect(markdown).toContain('1. First');
    expect(markdown).toContain('```ts');
    expect(markdown).toContain('const x: number = 1;');
    expect(markdown).toContain('> Quoted.');
    expect(markdown).toContain('| Year | Role |');
    expect(markdown).toContain('| 2024 | Engineer |');
    expect(markdown).toContain('[about](https://example.com/about)');
    expect(markdown).toContain('**bold**');
    expect(markdown).toContain('*italic*');
    expect(markdown).toContain('`inline`');
    expect(markdown).toContain('---');
  });

  it('warns when the raw HTML has almost no extractable content', () => {
    const html = page('<div id="root"></div>');
    const result = extractPage(html, { url: 'https://example.com/', minWords: 40 });
    expect(result.wordCount).toBeLessThan(40);
    expect(result.warnings.join(' ')).toMatch(/JavaScript|client/i);
  });

  it('reads the title and description from the document head', () => {
    const html = page('<main><p>Some content that is definitely long enough to count as real.</p></main>', '<meta name="description" content="A short summary.">');
    const result = extractPage(html, { url: 'https://example.com/' });
    expect(result.title).toBe('Test page');
    expect(result.description).toBe('A short summary.');
  });

  it('reads <link rel="canonical"> and resolves it against the page', () => {
    const body = '<main><p>Some content that is definitely long enough to count as real.</p></main>';
    expect(extractPage(page(body, '<link rel="canonical" href="/blog/">'), { url: 'https://example.com/blog' }).canonical).toBe('https://example.com/blog/');
    expect(extractPage(page(body), { url: 'https://example.com/blog' }).canonical).toBeUndefined();
  });

  it('reads the modification date a page declares, and ignores one that is not a date', () => {
    const body = '<main><p>Some content that is definitely long enough to count as real.</p></main>';
    const at = (/** @type {string} */ head) => extractPage(page(body, head), { url: 'https://example.com/' }).lastModified;
    expect(at('<meta property="article:modified_time" content="2024-05-06T07:08:09+02:00">')).toBe('2024-05-06T07:08:09+02:00');
    expect(at('<script type="application/ld+json">{"@graph":[{"@type":"WebPage","dateModified":"2024-05-06"}]}</script>')).toBe('2024-05-06');
    expect(at('<meta property="article:modified_time" content="last Tuesday">')).toBeUndefined();
    expect(at('')).toBeUndefined();
  });

  it('collects JSON-LD blocks without letting a broken one throw', () => {
    const html = page(
      '<main><p>Content long enough to be extracted by the algorithmic tier without warnings.</p></main>',
      '<script type="application/ld+json">{"@type":"Person","name":"A"}</script><script type="application/ld+json">{oops</script>',
    );
    const result = extractPage(html, { url: 'https://example.com/' });
    expect(result.jsonLd).toHaveLength(1);
    expect(result.warnings.join(' ')).toMatch(/JSON-LD block on this page does not parse/);
  });
});

describe('extraction keeps the page shape intact', () => {
  const words = 'Enough words in this paragraph to make the region count as real page content.';

  it('keeps every top-level <article> when the page has no <main>', () => {
    const html = page(`
      <nav><a href="/">Home</a></nav>
      <article><h2>First post</h2><p>${words}</p></article>
      <article><h2>Second post</h2><p>${words}</p></article>
    `);
    const result = extractPage(html, { url: 'https://example.com/' });
    expect(result.contentRoot).toBe('article');
    expect(result.markdown).toContain('## First post');
    expect(result.markdown).toContain('## Second post');
    expect(result.markdown).not.toContain('Home');
  });

  it('does not repeat the <h1> when something precedes it in the content', () => {
    const html = page(`<main><p>Docs / Guides</p><h1>Install guide</h1><p>${words}</p></main>`);
    const { markdown } = extractPage(html, { url: 'https://example.com/' });
    expect(markdown.match(/^# Install guide$/gm)).toHaveLength(1);
    expect(markdown).toContain('Docs / Guides');
  });

  it('turns a link wrapped around a card into a heading link, not a heading inside a link', () => {
    const html = page(`<main><h1>Blog</h1><a href="/posts/one"><div><h3>Post one</h3><p>${words}</p></div></a></main>`);
    const { markdown } = extractPage(html, { url: 'https://example.com/' });
    expect(markdown).toContain('### [Post one](https://example.com/posts/one)');
    expect(markdown).toContain(`\n\n${words}`);
    expect(markdown).not.toContain('[###');
  });

  it('keeps the destination of a block link that has no heading to hang it on', () => {
    const html = page(`<main><h1>Blog</h1><a href="/posts/two"><ul><li>One</li><li>Two</li></ul></a><p>${words}</p></main>`);
    const { markdown } = extractPage(html, { url: 'https://example.com/' });
    expect(markdown).toContain('- One\n- Two');
    expect(markdown).toContain('<https://example.com/posts/two>');
  });

  it('keeps a table row on one line when a cell has a <br> or a list in it', () => {
    const html = page(`<main><h1>Prices</h1>
      <table><tr><th>Plan</th><th>Notes</th></tr>
      <tr><td>Pro<br>yearly</td><td><ul><li>SSO</li><li>Audit log</li></ul></td></tr></table>
      <p>${words}</p></main>`);
    const { markdown } = extractPage(html, { url: 'https://example.com/' });
    expect(markdown).toContain('| Pro<br>yearly | - SSO<br>- Audit log |');
  });

  it('flattens a table nested in a cell instead of leaking its rows into the outer table', () => {
    const html = page(`<main><h1>Specs</h1>
      <table><tr><td>Size</td><td><table><tr><th>W</th><th>H</th></tr><tr><td>10</td><td>20</td></tr></table></td></tr>
      <tr><td>Weight</td><td>3 kg</td></tr></table>
      <p>${words}</p></main>`);
    const { markdown } = extractPage(html, { url: 'https://example.com/' });
    const table = markdown.split('\n').filter((line) => line.startsWith('|'));
    expect(table).toEqual([
      '|  |  |',
      '| --- | --- |',
      '| Size | W, H<br>10, 20 |',
      '| Weight | 3 kg |',
    ]);
  });

  it('keeps the content of a page wrapped in one <form>', () => {
    const html = page(`<form action="/postback" method="post">
      <h1>Opening hours</h1><p>${words}</p><p>Open 9 to 5 on weekdays.</p>
      <input type="hidden" name="__VIEWSTATE" value="x">
      <form><label>Email for the newsletter</label><input name="email"><button>Join</button></form>
    </form>`);
    const { markdown } = extractPage(html, { url: 'https://example.com/' });
    expect(markdown).toContain('# Opening hours');
    expect(markdown).toContain('Open 9 to 5 on weekdays.');
    expect(markdown).not.toContain('Join');
  });

  it('still drops a newsletter form beside the real content', () => {
    const html = page(`<main><h1>About</h1><p>${words}</p><form><label>Email for the newsletter</label><input name="email"></form></main>`);
    const { markdown } = extractPage(html, { url: 'https://example.com/' });
    expect(markdown).not.toContain('newsletter');
  });

  it('indents a nested list under an ordered item by the width of its marker', () => {
    const html = page(`<main><h1>Steps</h1>
      <ol><li>First<ol><li>Inner</li></ol></li><li>Second<p>More</p></li></ol>
      <ol start="10"><li>Ten<ul><li>Bullet<ol><li>Deep</li></ol></li></ul></li></ol>
      <p>${words}</p></main>`);
    const { markdown } = extractPage(html, { url: 'https://example.com/' });
    // CommonMark only nests a block under "1. " when it is indented at least three columns.
    expect(markdown).toContain('1. First\n   1. Inner\n2. Second\n   More');
    expect(markdown).toContain('10. Ten\n    - Bullet\n      1. Deep');
  });

  it('resolves relative links and images against <base href>, as a browser does', () => {
    const html = page(
      `<main><h1>Post</h1><p><a href="next">Next post</a> <img src="cover.png" alt="Cover"> ${words}</p></main>`,
      '<base href="https://example.com/blog/">',
    );
    const { markdown } = extractPage(html, { url: 'https://example.com/blog/post/one' });
    expect(markdown).toContain('[Next post](https://example.com/blog/next)');
    expect(markdown).toContain('![Cover](https://example.com/blog/cover.png)');
  });
});

describe('page text cannot forge markdown in the twin', () => {
  /**
   * Where every link and image in a markdown string points, ignoring anything escaped.
   * @param {string} markdown
   * @returns {string[]}
   */
  function destinations(markdown) {
    const unescaped = markdown.replace(/\\./g, '');
    return [...unescaped.matchAll(/\]\(([^)\s]*)\)/g)].map((match) => match[1]);
  }

  it('escapes image alt text, so it cannot close the image and open a link', () => {
    const html = page('<main><h1>T</h1><p>Words here. <img alt="a](https://evil.example/x) [b" src="/i.png"></p></main>');
    const { markdown } = extractPage(html, { url: 'https://example.com/' });
    expect(destinations(markdown)).toEqual(['https://example.com/i.png']);
    expect(markdown).toContain('evil.example');
  });

  it('escapes alt text that stands alone when the image has no source', () => {
    const html = page('<main><h1>T</h1><p>Words <img alt="[forged](https://evil.example/)"></p></main>');
    const { markdown } = extractPage(html, { url: 'https://example.com/' });
    expect(destinations(markdown)).toEqual([]);
  });

  it('keeps a parenthesis in a URL from ending the link early', () => {
    const html = page('<main><h1>T</h1><p><a href="https://example.com/a) [forged](https://evil.example/">Docs</a></p></main>');
    const { markdown } = extractPage(html, { url: 'https://example.com/' });
    expect(destinations(markdown)).toHaveLength(1);
    expect(destinations(markdown)[0]).toMatch(/^https:\/\/example\.com\//);
  });

  it('escapes text that would read as an HTML tag, and leaves a plain less-than alone', () => {
    const html = page('<main><h1>T</h1><p>Use &lt;img src=x onerror=alert(1)&gt; with care, since 2 &lt; 3.</p></main>');
    const { markdown } = extractPage(html, { url: 'https://example.com/' });
    expect(markdown).not.toMatch(/(^|[^\\])<img/);
    expect(markdown).toContain('\\<img');
    expect(markdown).toContain('2 < 3');
  });
});
