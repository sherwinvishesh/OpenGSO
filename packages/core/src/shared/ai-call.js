import { providerOverridesOf } from './config.js';
import { readCredentials, readNativeKey } from './env.js';
import { ERRORS } from './errors.js';
import { AI_PROVIDERS, DEFAULT_MODELS, isAiProvider, providerInfo } from './providers.js';

/**
 * @import { OpenGeoConfig } from './config.js'
 * @import { Credentials } from './env.js'
 * @import { AiProvider, ProviderOverrides } from './providers.js'
 */

/**
 * Which provider to call, with which key, at which address (§11).
 *
 * Four sources feed the answer: a `--provider`/`--model` flag, `.env`, the process environment and
 * the config file. Each of them describes one provider, and the failure that matters is mixing two:
 * one provider's key sent to another, or sent to the gateway configured for a third. So nothing is
 * taken from a source unless it describes the provider actually being called. The CLI and the
 * dashboard both come through here, which is what keeps them from disagreeing about it.
 */

/**
 * @typedef {object} AiCall
 * @property {AiProvider} provider
 * @property {string} model
 * @property {string} apiKey
 * @property {ProviderOverrides} overrides
 * @property {Credentials['source']} [keySource] Where the key came from. Absent for a provider that
 *   runs without one.
 */

/**
 * `missing` is not an error on its own: a missing key is a footnote to a structural test and a
 * refusal to generate's AI tier, and only the caller knows which.
 *
 * `usage` marks the one error that is the command line's fault, a `--provider` that does not exist.
 *
 * @typedef {{ call: AiCall } | { missing: AiProvider } | { error: string; usage?: boolean }} AiResolution
 */

/**
 * @param {string} root
 * @param {Pick<OpenGeoConfig, 'ai'>} config
 * @param {{ provider?: string; model?: string }} [flags]
 * @returns {AiResolution}
 */
export function resolveAiCall(root, config, flags = {}) {
  if (flags.provider && !isAiProvider(flags.provider)) {
    return { error: ERRORS.unknownProvider(flags.provider, AI_PROVIDERS), usage: true };
  }

  const credentials = readCredentials(root);
  const provider = /** @type {AiProvider | undefined} */ (flags.provider) || credentials?.provider || config.ai.provider;
  // `.env` outranks the config, as it always has, but only where both describe this provider.
  const fromEnv = credentials?.provider === provider ? credentials : undefined;
  const fromConfig = config.ai.provider === provider ? config.ai : undefined;

  const keyless = Boolean(providerInfo(provider).keyless) || fromConfig?.auth === 'none';
  const key = fromEnv?.apiKey ? { value: fromEnv.apiKey, source: fromEnv.source } : readNativeKey(root, provider);
  if (!key && !keyless) {
    // There is a key, and it is somebody else's. Saying nothing would read as "no key configured",
    // which is untrue and sends the user looking in the wrong place.
    if (credentials && !fromEnv && !credentials.keyless) {
      return { error: ERRORS.keyForOtherProvider(provider, credentials.provider) };
    }
    return { missing: provider };
  }

  /** @type {ProviderOverrides} */
  const overrides = fromConfig ? providerOverridesOf(config) : {};
  if (fromEnv?.baseUrl) overrides.baseUrl = fromEnv.baseUrl;

  return {
    call: {
      provider,
      model: flags.model || fromEnv?.model || fromConfig?.model || DEFAULT_MODELS[provider],
      apiKey: key?.value ?? '',
      overrides,
      keySource: key?.source,
    },
  };
}
