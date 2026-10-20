/**
 * The default entry point deliberately exports only `shared`.
 *
 * Each pillar has its own subpath (`@omnigeo/core/generate`, `/test`, `/prod`, `/cli`) so that
 * importing one never drags the others' dependencies in - the reason `omnigeo-prod` can ship with
 * no jsdom and no AI code at all (§3).
 */
export * from './shared/index.js';
