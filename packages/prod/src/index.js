/**
 * opengso-prod: the runtime half of OpenGSO (§7).
 *
 * Serves the markdown twins that `opengso generate` already wrote to disk. It never generates,
 * never calls an AI provider, and never needs an API key.
 */
export * from '@opengso/core/prod';
