/**
 * The lexer: source text to tokens, and a diagnostic for anything it cannot
 * read.
 *
 * The whole of language.md section 3 lives behind this door. What comes out is
 * a flat list of tokens with the layout already decided, so nothing downstream
 * counts a space or wonders whether a line was blank: a newline token ends a
 * statement, an indent and a dedent bracket a block, and a line that carried no
 * token is simply not in the list.
 */
export { lex } from './lexer.js';
//# sourceMappingURL=index.js.map