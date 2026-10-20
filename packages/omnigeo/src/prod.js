/**
 * The runtime half, re-exported so a project that installed only `omnigeo` needs nothing else:
 * `import { handleRequest } from 'omnigeo/prod'`.
 *
 * Identical code to `omnigeo-prod`. That package still exists because it is the one you install on
 * the server, where jsdom and the generate pipeline have no business being.
 */
export * from '@omnigeo/core/prod';
