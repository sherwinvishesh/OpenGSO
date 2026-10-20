/**
 * The one element helper, and the handful of primitives every screen shares. Nothing here knows
 * what OpenGEO is.
 *
 * Text only ever reaches the page through `textContent` and text nodes. Nothing in the dashboard
 * parses a string as markup, so a page title, a model's recommendation or a crawler name typed into
 * a form is shown as the characters it is. `ui.test.js` fails if a markup-parsing API appears.
 */

/** @type {Document | undefined} */
let current;

/**
 * Which document elements are made in. The browser never calls this; tests pass a jsdom document,
 * so the same drawing code runs there without a global `document`.
 *
 * @param {Document} doc
 */
export function useDocument(doc) {
  current = doc;
}

/** @returns {Document} */
export function doc() {
  return current ?? globalThis.document;
}

/**
 * @typedef {Node | string | number | null | undefined | false} Leaf
 * @typedef {Leaf | Array<Leaf | Array<Leaf | Leaf[]>>} Child Nested as deep as any caller actually nests.
 */

/**
 * @typedef {object} Props
 * @property {string} [className]
 * @property {string} [text] Shorthand for a single text child.
 * @property {Record<string, string | number | boolean | undefined>} [attrs] `false` and `undefined`
 *   leave the attribute off; `true` sets it empty. `href` must be an http or https URL.
 * @property {{ [K in keyof HTMLElementEventMap]?: (event: HTMLElementEventMap[K]) => void }} [on]
 * @property {Partial<Record<'width' | 'background' | 'color' | 'margin' | 'marginTop' | 'fontSize' | 'wordBreak' | 'whiteSpace' | 'textTransform' | 'letterSpacing' | 'paddingLeft', string>>} [style]
 *   Through the CSSOM, which the page's CSP allows. A `style` attribute it would refuse.
 * @property {boolean} [hidden]
 */

/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {Props} [props]
 * @param {...Child} children
 * @returns {HTMLElementTagNameMap[K]}
 */
export function el(tag, props = {}, ...children) {
  const node = doc().createElement(tag);
  apply(node, props);
  append(node, children);
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * @template {keyof SVGElementTagNameMap} K
 * @param {K} tag
 * @param {Record<string, string | number>} [attrs]
 * @param {...Child} children
 * @returns {SVGElementTagNameMap[K]}
 */
export function svg(tag, attrs = {}, ...children) {
  const node = /** @type {SVGElementTagNameMap[K]} */ (doc().createElementNS(SVG_NS, tag));
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  append(node, children);
  return node;
}

/**
 * @param {HTMLElement} node
 * @param {Props} props
 */
function apply(node, props) {
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.hidden) node.hidden = true;
  for (const [name, value] of Object.entries(props.attrs ?? {})) setAttr(node, name, value);
  for (const [name, value] of Object.entries(props.style ?? {})) {
    if (value !== undefined) node.style.setProperty(name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), value);
  }
  for (const [type, handler] of Object.entries(props.on ?? {})) {
    if (handler) node.addEventListener(type, /** @type {EventListener} */ (handler));
  }
}

/**
 * The single place an attribute is written. Event handler attributes and `style` are refused
 * outright, and a link goes nowhere unless it is http or https: a `javascript:` URL in a provider
 * catalogue or a crawled page must never become something to click.
 *
 * @param {Element} node
 * @param {string} name
 * @param {string | number | boolean | undefined} value
 */
export function setAttr(node, name, value) {
  const lower = name.toLowerCase();
  if (lower.startsWith('on') || lower === 'style' || lower === 'srcdoc') throw new Error(`Refusing to set ${name} as an attribute.`);
  if (value === undefined || value === false) {
    node.removeAttribute(name);
    return;
  }
  if (lower === 'href' || lower === 'src' || lower === 'action') {
    const safe = safeUrl(String(value));
    if (safe === undefined) {
      node.removeAttribute(name);
      return;
    }
    node.setAttribute(name, safe);
    return;
  }
  node.setAttribute(name, value === true ? '' : String(value));
}

/**
 * @param {string} value
 * @returns {string | undefined} The URL when it is absolute http or https, otherwise nothing.
 */
export function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {Node} node
 * @param {Child[]} children
 */
function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'object' ? /** @type {Node} */ (child) : doc().createTextNode(String(child)));
  }
}

/**
 * Swaps a node's children. The caller decides how much to redraw; this only saves it from writing
 * the loop.
 *
 * @param {Node & ParentNode} node
 * @param {...Child} children
 */
export function fill(node, ...children) {
  node.replaceChildren();
  append(node, children);
}

/**
 * Sets text only when it differs, so a redraw that changes nothing touches nothing.
 *
 * @param {Node} node
 * @param {string} text
 */
export function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

// -- primitives ----------------------------------------------------------------------------------

/**
 * @param {string} className
 * @param {...Child} children
 */
export function card(className, ...children) {
  return el('section', { className: className ? `card ${className}` : 'card' }, ...children);
}

/**
 * @param {{ title: string; sub?: string; right?: Child }} props
 */
export function cardHead({ title, sub, right }) {
  return el('header', { className: 'card-head' }, el('div', {}, el('h2', { text: title }), sub ? el('div', { className: 'sub', text: sub }) : null), right);
}

/**
 * @param {string} title
 * @param {...Child} children
 */
export function pageHead(title, ...children) {
  return el('div', { className: 'page-head' }, el('h1', { text: title }), children.length > 0 ? el('p', {}, ...children) : null);
}

/** @typedef {'ok' | 'warn' | 'fail' | 'info'} BannerTone */

/**
 * @param {{ tone: BannerTone; title?: string; action?: Child }} props
 * @param {...Child} children
 */
export function banner({ tone, title, action }, ...children) {
  return el(
    'div',
    { className: `banner banner-${tone}`, attrs: { role: tone === 'fail' ? 'alert' : undefined } },
    el('div', { className: 'banner-body' }, title ? el('h2', { text: title }) : null, el('p', {}, ...children)),
    action,
  );
}

/**
 * @param {'ok' | 'fail' | 'warn' | 'mute' | 'info'} tone
 * @param {...Child} children
 */
export function pill(tone, ...children) {
  return el('span', { className: `pill pill-${tone}` }, ...children);
}

/**
 * @typedef {object} ButtonProps
 * @property {string} label
 * @property {() => void} [onClick]
 * @property {boolean} [primary]
 * @property {boolean} [small]
 * @property {boolean} [disabled]
 * @property {'button' | 'submit'} [type]
 */

/**
 * A button that can show it is working. `setBusy` disables it and adds the spinner; the label and
 * the node stay the same, so focus is not lost mid-run.
 *
 * @param {ButtonProps} props
 */
export function button({ label, onClick, primary, small, disabled, type = 'button' }) {
  const classes = ['btn', primary ? 'btn-primary' : '', small ? 'btn-sm' : ''].filter(Boolean).join(' ');
  const node = el('button', { className: classes, attrs: { type }, on: onClick ? { click: () => onClick() } : {} });
  const label_ = doc().createTextNode(label);
  node.append(label_);
  node.disabled = Boolean(disabled);
  return node;
}

/**
 * @param {HTMLButtonElement} node
 * @param {boolean} busy
 * @param {boolean} [disabled] Disabled for a reason other than being busy.
 */
export function setBusy(node, busy, disabled = false) {
  const spinner = node.querySelector(':scope > .spinner');
  if (busy && !spinner) node.prepend(el('span', { className: 'spinner', attrs: { 'aria-hidden': 'true' } }));
  if (!busy && spinner) spinner.remove();
  node.disabled = busy || disabled;
}

/**
 * @param {HTMLButtonElement} node
 * @param {string} label
 */
export function setLabel(node, label) {
  const text = [...node.childNodes].find((child) => child.nodeType === 3);
  if (text) setText(text, label);
  else node.append(label);
}

let fieldIds = 0;

/**
 * A labelled control. The hint is tied to the control with `aria-describedby` rather than sitting
 * inside the label, where it would become part of the control's name and be read out every time.
 *
 * @param {string} label
 * @param {HTMLElement} control
 * @param {Child} [hint]
 */
export function field(label, control, hint) {
  const id = control.id || `f${++fieldIds}`;
  control.id = id;
  const hintNode = hint ? el('span', { className: 'hint', attrs: { id: `${id}-hint` } }, hint) : null;
  if (hintNode) control.setAttribute('aria-describedby', hintNode.id);
  return el('div', { className: 'field' }, el('label', { attrs: { for: id }, text: label }), control, hintNode);
}

/**
 * @param {string} title
 * @param {...Child} children
 */
export function empty(title, ...children) {
  return el('div', { className: 'empty' }, el('strong', { text: title }), children.length > 0 ? el('p', {}, ...children) : null);
}

/**
 * A path the server sent, shown from the project folder when it is inside it. The sidebar already
 * names the project, so repeating its absolute path on every row only pushes the part that differs
 * off the end. Either separator ends the root, because the server may be on Windows.
 *
 * @param {string} path
 * @param {string} root
 * @returns {string}
 */
export function projectPath(path, root) {
  const base = root.replace(/[\\/]+$/, '');
  const next = path.charAt(base.length);
  return base && path.startsWith(base) && (next === '/' || next === '\\') ? path.slice(base.length + 1) : path;
}

/**
 * Relative time, in the tense the reader is actually thinking in.
 *
 * @param {string} iso
 * @param {number} [now]
 * @returns {string}
 */
export function ago(iso, now = Date.now()) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'unknown';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 31) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.round(days / 30);
  return `${months} month${months === 1 ? '' : 's'} ago`;
}
