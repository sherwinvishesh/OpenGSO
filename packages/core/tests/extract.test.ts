import { describe, expect, it } from 'vitest';
import { extractPage } from '@opengeo/core/generate';

const page = (body: string, head = '') => `<!doctype html><html><head><title>Test page</title>${head}</head><body>${body}</body></html>`;

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
