import { register } from 'node:module';

/** Entry point for `node --import`. See extensionless-hooks.mjs for the why. */
register('./extensionless-hooks.mjs', import.meta.url);
