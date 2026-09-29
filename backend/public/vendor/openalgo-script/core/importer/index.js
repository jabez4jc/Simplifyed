/**
 * The importer: a script written in another chart language, as OpenScript.
 *
 * `importScript` reads a script in the version-annotated chart dialect, the one
 * whose scripts open with a `//@version=` comment and reach their built-ins
 * through namespaces, and returns the OpenScript text and a finding for every
 * statement it kept as a comment and every translation whose meaning differs in
 * a stated way. It is pure: text in, text and findings out, and nothing read,
 * written or evaluated on the way.
 *
 * `MAPPINGS` and `COLOURS` are the table of what translates to what. They are
 * behind this door for the documentation page's comparison test and for a tool
 * that wants to show a reader the same table; the package surface is
 * `importScript` and its two types.
 */
export { importScript } from './importer.js';
export { COLOURS, MAPPINGS } from './table.js';
//# sourceMappingURL=index.js.map