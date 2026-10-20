// A classic script in <head>, not a module: modules run after the first paint, and a dark-mode
// user would see the light page flash first. A file rather than inline, because the page's CSP
// allows no inline script. `app.js` reads the result back off the root element.
(() => {
  /** @type {string | null} */
  let stored = null;
  try {
    stored = localStorage.getItem('opengso.theme');
  } catch {
    // Storage disabled. The OS preference still applies, it is just not remembered.
  }
  const dark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = stored === 'light' || stored === 'dark' ? stored : dark ? 'dark' : 'light';
})();
