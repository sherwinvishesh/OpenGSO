// The runtime entry is what a server imports on every boot, so it carries the middleware and
// nothing else. Deployment verification (`verify.js`, `verify-report.js`) makes network calls and
// paints a terminal, and lives behind the `prod test` command, which imports it directly. The
// startup module is named rather than starred so its test hook stays out of the public API.
//
// It is the fs-free edge entry plus the two things that read the disk.
export * from './edge.js';
export { createFsStore } from './store.js';
/** @typedef {import('./store.js').FsStoreOptions} FsStoreOptions */
export { buildStartupStatus, logStartupStatus } from './startup.js';
/**
 * @typedef {import('./startup.js').StartupStatus} StartupStatus
 * @typedef {import('./startup.js').StartupStatusOptions} StartupStatusOptions
 * @typedef {import('./startup.js').FileStatus} FileStatus
 */
