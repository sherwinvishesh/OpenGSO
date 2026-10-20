/**
 * omnigeo-prod: the runtime half of OmniGEO (§7).
 *
 * Serves the markdown twins that `omnigeo generate` already wrote to disk. It never generates,
 * never calls an AI provider, and never needs an API key.
 */
export * from '@omnigeo/core/prod';
