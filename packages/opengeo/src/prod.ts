/**
 * The runtime half, re-exported so a project that installed only `opengeo` needs nothing else:
 * `import { handleRequest } from 'opengeo/prod'`.
 *
 * Identical code to `opengeo-prod`. That package still exists because it is the one you install on
 * the server, where jsdom and the generate pipeline have no business being.
 */
export * from '@opengeo/core/prod';
