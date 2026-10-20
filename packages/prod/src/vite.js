/**
 * The Vite plugin: `import { opengeo } from 'opengeo-prod/vite'`, then `plugins: [opengeo()]`.
 *
 * Serves the twins from `vite` and `vite preview` the way the production middleware will.
 */
export * from '@opengeo/core/prod/vite';
export { default } from '@opengeo/core/prod/vite';
