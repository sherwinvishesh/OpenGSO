/**
 * opengeo-prod: the runtime half of OpenGEO (idea.md §7).
 *
 * Serves the markdown twins that `opengeo generate` already wrote to disk. It never generates,
 * never calls an AI provider, and never needs an API key.
 */
export * from '@opengeo/core/prod';
