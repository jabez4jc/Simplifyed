/**
 * Every kind of token language.md section 3 describes. Types and the two tables
 * they are derived from, and no scanning: the lexer is the next stage.
 *
 * A keyword's kind is the word, and a punctuation token's kind is the symbol,
 * so a parser reads as `token.kind === 'if'` and `token.kind === '('` rather
 * than through a second vocabulary that has to be learned and kept in step.
 */
/**
 * The reserved words of language.md 3.4, which cannot be used as names.
 *
 * `import`, `map`, `matrix`, `type` and `as` are reserved and unused in version
 * 1. They are here so that adding them later cannot break a script that used
 * one as a variable name.
 *
 * Two words the grammar treats as keywords are deliberately absent, because 3.4
 * does not reserve them: `version` and `limits` are recognised by position in
 * the parser and are ordinary identifiers to the lexer.
 */
export const RESERVED_WORDS = [
    'and',
    'array',
    'as',
    'bool',
    'break',
    'case',
    'color',
    'continue',
    'default',
    'else',
    'false',
    'fn',
    'for',
    'if',
    'import',
    'in',
    'is',
    'live',
    'map',
    'matrix',
    'none',
    'not',
    'number',
    'or',
    'return',
    'series',
    'step',
    'string',
    'strategy',
    'study',
    'switch',
    'to',
    'true',
    'type',
    'var',
    'while',
];
/**
 * The operator and punctuation tokens of language.md 3.12, longest first so a
 * lexer taking them in order takes the longest match.
 *
 * `!` is not in the list and is not an operator on its own: it exists only as
 * the first half of `!=`, and a lone one is OS1001 with the fix to write `not`.
 * There are no bitwise, increment or exponent operators for the same reason
 * they are missing from the specification, so there is nothing here to add.
 */
export const PUNCTUATORS = [
    '==',
    '!=',
    '<=',
    '>=',
    '+=',
    '-=',
    '*=',
    '/=',
    '%=',
    '+',
    '-',
    '*',
    '/',
    '%',
    '<',
    '>',
    '=',
    '(',
    ')',
    '[',
    ']',
    ',',
    '.',
    '?',
    ':',
];
//# sourceMappingURL=kind.js.map