/**
 * Node module resolution hook: retry a failed relative import with `.js`.
 *
 * The whole `src/` tree uses extensionless relative imports, which Vite resolves
 * and Node does not. Rather than rewrite every import in the app to suit one
 * build script, the script runs under this hook. Registered by `loader.mjs`.
 */

const RELATIVE = /^\.{1,2}\//;
const HAS_EXTENSION = /\.[a-z0-9]+$/i;

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (RELATIVE.test(specifier) && !HAS_EXTENSION.test(specifier)) {
      return nextResolve(`${specifier}.js`, context);
    }
    throw error;
  }
}
