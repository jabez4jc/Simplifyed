/**
 * The parser: tokens to a syntax tree, and a diagnostic for anything the
 * grammar does not have a shape for.
 *
 * The whole of language.md section 19 lives behind this door, with the prose of
 * sections 9 to 13 winning wherever the two disagree. What comes out is a tree
 * for every file, including a file with mistakes in it: a parse error costs the
 * statement it is on and nothing else, so an editor asking about a half typed
 * line still gets a tree, and a compile reports every mistake in a file rather
 * than the first one.
 */
export { parse, parseTokens } from './script.js';
//# sourceMappingURL=index.js.map