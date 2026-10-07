/**
 * The edge entry point: `import { createManifestStore, createProdHandler } from 'opengeo-prod/edge'`.
 *
 * The same middleware as the main entry, minus the two pieces that read the disk (`createFsStore`
 * and the startup log), so nothing in it imports a `node:` module and an edge bundler accepts it.
 */
export * from '@opengeo/core/prod/edge';
