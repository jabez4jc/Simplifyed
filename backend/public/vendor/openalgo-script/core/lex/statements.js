/**
 * Where a statement ends, and whether it opens a block. Both questions are
 * asked of the tokens of a line, which is the whole of what language.md 3.10
 * and 3.11 need to know about a statement before it is parsed.
 */
/**
 * The tokens that promise a right-hand side, from 3.11: a binary operator, a
 * comma, a `?`, a `:` or an `=`. A line ending in one of them continues onto
 * the next line.
 *
 * The compound assignments are here on the same terms as `=`: each one promises
 * a value just as plainly. `.` is deliberately absent, because 3.11 does not
 * list it and a line that ends in a dot is a mistake rather than a wrap.
 */
const CONTINUING = new Set([
    '+',
    '-',
    '*',
    '/',
    '%',
    '==',
    '!=',
    '<',
    '<=',
    '>',
    '>=',
    '=',
    '+=',
    '-=',
    '*=',
    '/=',
    '%=',
    ',',
    '?',
    ':',
    'and',
    'or',
]);
/** The words that introduce a block, per 3.10 and the grammar of section 19. */
const HEADERS = new Set([
    'if',
    'else',
    'for',
    'while',
    'switch',
    'case',
    'default',
]);
/**
 * Whether the last two tokens are the `=>` of a function declaration.
 *
 * Section 3.12 does not list `=>` among the punctuation, so it arrives as an
 * `=` and a `>` that touch. Both readings need saying apart here: a line whose
 * last token is `>` continues onto the next line, and a line that ends in `=>`
 * is a function header whose body is the indented block below it, so it must
 * not.
 */
export function endsWithArrow(tokens) {
    const last = tokens[tokens.length - 1];
    const before = tokens[tokens.length - 2];
    if (last === undefined || before === undefined)
        return false;
    return (last.kind === '>' &&
        before.kind === '=' &&
        before.span.offset + before.span.length === last.span.offset);
}
/** Whether the statement so far promises more, so the next line belongs to it. */
export function continuesLine(tokens) {
    const last = tokens[tokens.length - 1];
    if (last === undefined)
        return false;
    if (endsWithArrow(tokens))
        return false;
    return CONTINUING.has(last.kind);
}
/**
 * Whether a statement that begins with this token and ends this way opens a
 * block.
 *
 * `fn` is the one header with a form that fits on one line: with its body after
 * the `=>` it opens nothing, and with nothing after the `=>` the block below it
 * is the body (3.10, 11.1). Every other header opens a block always, because
 * there is no statement separator to end a one-line body with.
 */
export function opensBlock(firstKind, arrowAtEnd) {
    if (firstKind === 'fn')
        return arrowAtEnd;
    return HEADERS.has(firstKind);
}
//# sourceMappingURL=statements.js.map