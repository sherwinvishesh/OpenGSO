/**
 * The hand-rolled terminal interface layer.
 *
 * Nothing here is exported from `@opengeo/core`'s public entry points: it is used only by core's own
 * CLI, so it costs no addition to the exports map and cannot reach `opengeo-prod`.
 */
export * from './paint.js';
export * from './theme.js';
export * from './widgets.js';
export * from './screen.js';
export * from './keys.js';
