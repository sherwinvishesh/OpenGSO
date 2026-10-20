import { el, field, fill, setText } from '../ui.js';

/** @import { ProviderInfo, StateResponse } from '../../../core/src/shared/api-types.js' */

/**
 * The provider half of the key form, shared by Settings and onboarding so the two can never drift.
 *
 * Everything here is driven by the catalogue the server sends, not by a list written into the
 * page. Adding a provider to core makes it appear in this dropdown without a dashboard change,
 * which is the whole reason the catalogue is in the state response.
 *
 * Three shapes come out of that: a hosted provider needs a key and nothing else, a keyless one
 * (a model server on this machine) needs no key at all, and a user-defined one needs the endpoint
 * and the wire format because OmniGEO has no way to guess them.
 */

/**
 * @typedef {object} ProviderDraft
 * @property {string} provider
 * @property {string} model
 * @property {string} apiKey
 * @property {string} baseUrl
 * @property {string} api
 */

/**
 * @param {ProviderInfo[]} catalog
 * @param {string} id
 * @returns {ProviderInfo | undefined}
 */
export function providerInfoOf(catalog, id) {
  return catalog.find((entry) => entry.id === id);
}

/**
 * Switching provider resets the fields that belonged to the old one. Keeping them would send a
 * Claude model id to Groq, and the error that produces explains nothing.
 *
 * @param {ProviderInfo[]} catalog
 * @param {string} id
 * @param {string} [apiKey]
 * @returns {ProviderDraft}
 */
export function draftForProvider(catalog, id, apiKey = '') {
  const info = providerInfoOf(catalog, id);
  return {
    provider: id,
    model: info?.userDefined ? '' : (info?.defaultModel ?? ''),
    apiKey,
    baseUrl: info?.userDefined ? '' : (info?.baseUrl ?? ''),
    api: info?.api ?? 'openai',
  };
}

/**
 * Whether the form has enough to write. A keyless provider is complete without a secret, and so is
 * one whose key is already saved: a blank field then keeps that key and changes only the rest.
 *
 * @param {ProviderDraft} draft
 * @param {ProviderInfo | undefined} info
 * @param {{ keyOptional?: boolean; keyPresent?: boolean }} [options] `keyPresent` means a key for
 *   this provider is already saved, which `keyKept` decides.
 * @returns {boolean}
 */
export function draftReady(draft, info, { keyOptional = false, keyPresent = false } = {}) {
  if (!draft.model.trim()) return false;
  if (info?.userDefined && !draft.baseUrl.trim()) return false;
  if (info?.keyless) return true;
  return keyOptional || keyPresent || draft.apiKey.trim().length > 0;
}

/**
 * Whether saving with a blank key field keeps a key, for this provider.
 *
 * Only when the saved key belongs to the provider being saved. Keeping an Anthropic key while
 * switching to Groq would attach it to a request to Groq, which is exactly the second destination
 * the key policy promises never exists.
 *
 * @param {StateResponse['key']} key
 * @param {string} provider
 * @returns {boolean}
 */
export function keyKept(key, provider) {
  return key.present && key.provider === provider;
}

/**
 * The catalogue's own name for the bring-your-own-endpoint option, so a note telling somebody to
 * pick it names an option that exists.
 *
 * @param {ProviderInfo[]} catalog
 * @returns {string}
 */
export function customEndpointLabel(catalog) {
  return catalog.find((entry) => entry.userDefined)?.label ?? 'Your own endpoint';
}

/**
 * The dropdown's options, grouped by what picking one asks of you: an account, nothing at all, or
 * an address. Twenty-odd vendors in one flat list hide the two local ones somewhere in the middle.
 *
 * @param {ProviderInfo[]} catalog
 * @returns {Array<{ label: string; entries: ProviderInfo[] }>}
 */
export function providerGroups(catalog) {
  return [
    { label: 'Hosted, needs a key', entries: catalog.filter((entry) => !entry.keyless && !entry.userDefined) },
    { label: 'On this machine, no key', entries: catalog.filter((entry) => entry.keyless) },
    { label: 'Your own endpoint', entries: catalog.filter((entry) => entry.userDefined) },
  ].filter((group) => group.entries.length > 0);
}

/**
 * @typedef {object} ProviderFields
 * @property {HTMLElement} node
 * @property {() => ProviderDraft} get
 * @property {(draft: ProviderDraft) => void} set Fills the fields without calling `onChange`.
 * @property {(text: { label: string; placeholder?: string }) => void} setKey
 */

/**
 * The fields, built once. Changing provider shows and hides the parts that depend on it rather than
 * redrawing, so the select keeps focus while somebody arrows through it.
 *
 * @param {object} props
 * @param {ProviderInfo[]} props.catalog
 * @param {(draft: ProviderDraft) => void} props.onChange Called after every edit, with a copy.
 * @param {string} props.keyLabel
 * @param {string} [props.keyHint]
 * @param {string} [props.keyPlaceholder]
 * @returns {ProviderFields}
 */
export function createProviderFields({ catalog, onChange, keyLabel, keyHint, keyPlaceholder }) {
  /** @type {ProviderDraft} */
  let draft = draftForProvider(catalog, catalog[0]?.id ?? '');

  const provider = el(
    'select',
    { on: { change: () => edit(draftForProvider(catalog, provider.value, draft.apiKey)) } },
    providerGroups(catalog).map((group) =>
      el('optgroup', { attrs: { label: group.label } }, group.entries.map((entry) => el('option', { attrs: { value: entry.id }, text: entry.label }))),
    ),
  );
  // What would otherwise be learned from a failed run: a region, a permission, a server flag.
  const providerNote = el('p', { className: 'note', hidden: true });
  const model = el('input', { attrs: { type: 'text', spellcheck: 'false' }, on: { input: () => edit({ ...draft, model: model.value }) } });
  const modelHint = el('span');
  const baseUrl = el('input', {
    attrs: { type: 'text', spellcheck: 'false', placeholder: 'https://gateway.example.com/v1' },
    on: { input: () => edit({ ...draft, baseUrl: baseUrl.value }) },
  });
  const api = el(
    'select',
    { on: { change: () => edit({ ...draft, api: api.value }) } },
    el('option', { attrs: { value: 'openai' }, text: 'OpenAI-compatible' }),
    el('option', { attrs: { value: 'anthropic' }, text: 'Anthropic' }),
    el('option', { attrs: { value: 'gemini' }, text: 'Gemini' }),
  );
  const apiKey = el('input', {
    attrs: { type: 'password', spellcheck: 'false', autocomplete: 'off', placeholder: keyPlaceholder },
    on: { input: () => edit({ ...draft, apiKey: apiKey.value }) },
  });
  // Outside the label and tied by aria-describedby, so the keys link is a link of its own and not
  // part of the field's name.
  const keyHintNode = el('span');
  // Null until the first draw, so a provider with no keys page still draws the plain hint once.
  /** @type {string | undefined | null} */
  let hintUrl = null;

  const customRow = el(
    'div',
    { className: 'row row-top', hidden: true },
    el('div', { className: 'grow' }, field('Base URL', baseUrl, 'Everything up to the endpoint path, with no trailing slash.')),
    field('API shape', api, 'Which request format it speaks.'),
  );
  const keylessLabel = el('span');
  const keylessUrl = el('span', { className: 'mono' });
  const keylessNote = el('p', { className: 'note', hidden: true }, keylessLabel, ' runs on this machine at ', keylessUrl, '. There is no key to enter and nothing leaves the box.');
  const keyField = field(keyLabel, apiKey, keyHintNode);
  const keyLabelNode = /** @type {HTMLLabelElement} */ (keyField.querySelector('label'));

  const node = el(
    'div',
    { className: 'contents' },
    el('div', { className: 'row row-top' }, field('Provider', provider), el('div', { className: 'grow' }, field('Model', model, modelHint))),
    providerNote,
    customRow,
    keylessNote,
    keyField,
  );

  /** @param {ProviderDraft} next */
  function edit(next) {
    set(next);
    onChange({ ...draft });
  }

  /** @param {ProviderDraft} next */
  function set(next) {
    draft = { ...next };
    const info = providerInfoOf(catalog, draft.provider);
    const custom = Boolean(info?.userDefined);
    if (provider.value !== draft.provider) provider.value = draft.provider;
    if (model.value !== draft.model) model.value = draft.model;
    if (baseUrl.value !== draft.baseUrl) baseUrl.value = draft.baseUrl;
    if (api.value !== draft.api) api.value = draft.api;
    if (apiKey.value !== draft.apiKey) apiKey.value = draft.apiKey;

    setText(modelHint, custom ? 'The model id your endpoint expects.' : info ? `Default: ${info.defaultModel}` : '');
    customRow.hidden = !custom;
    keylessNote.hidden = !info?.keyless;
    keyField.hidden = Boolean(info?.keyless);
    setText(keylessLabel, info?.label ?? '');
    setText(keylessUrl, info?.baseUrl ?? '');
    // The custom row and the keyless line already say what the catalogue note would.
    const note = info?.userDefined ? '' : (info?.note ?? '').replace(/^No key, no network\. /, '');
    setText(providerNote, note);
    providerNote.hidden = !note;

    const keysUrl = info?.keysUrl;
    if (keysUrl === hintUrl) return;
    hintUrl = keysUrl;
    fill(
      keyHintNode,
      keyHint,
      keysUrl
        ? [
            keyHint ? ' ' : '',
            'Get one at ',
            el('a', { attrs: { href: keysUrl, target: '_blank', rel: 'noreferrer noopener' }, text: keysUrl }),
            '.',
          ]
        : null,
    );
  }

  set(draft);
  return {
    node,
    get: () => ({ ...draft }),
    set,
    setKey({ label, placeholder }) {
      setText(keyLabelNode, label);
      if (placeholder) apiKey.placeholder = placeholder;
      else apiKey.removeAttribute('placeholder');
    },
  };
}
