/**
 * The runtime half, re-exported so a project that installed only `opengso` needs nothing else:
 * `import { handleRequest } from 'opengso/prod'`.
 *
 * Identical code to `opengso-prod`. That package still exists because it is the one you install on
 * the server, where jsdom and the generate pipeline have no business being.
 */
export * from '@opengso/core/prod';
