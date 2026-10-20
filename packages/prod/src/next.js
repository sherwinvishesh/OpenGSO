/**
 * The Next.js entry point: `import { createNextMiddleware } from 'omnigeo-prod/next'`.
 *
 * It imports nothing from `next` itself - it takes a Request and hands back a decision, so it works
 * from middleware, a route handler, or anywhere else that can see the request.
 */
export * from '@omnigeo/core/prod/next';
