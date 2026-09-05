/**
 * Constants tsup substitutes at build time (see each package's tsup.config.ts), so the CLI reports
 * its own real name and version without a second copy of them drifting in source.
 */
declare const __OPENGEO_PACKAGE__: string;
declare const __OPENGEO_VERSION__: string;
