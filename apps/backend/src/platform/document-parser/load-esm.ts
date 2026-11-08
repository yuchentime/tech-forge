/**
 * Loads an ESM-only dependency from the CommonJS backend.
 *
 * `tsc` with `module: commonjs` rewrites `import()` into `require()`, which fails for packages
 * that ship only `.mjs` entry points (pdfjs-dist 6). Building the import at runtime keeps the
 * ESM semantics intact on both the plain Node backend and Electron's utility process.
 */
export function loadEsmModule<T = unknown>(specifier: string): Promise<T> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (
    value: string,
  ) => Promise<T>;
  return dynamicImport(specifier);
}
