import { makeNode } from '../ast/index.js';
import { spanning } from '../span/index.js';
import { parseTypeAnnotation } from './annotations.js';
import { parseBlock } from './blocks.js';
import { parseBracketedList, parseExpression } from './expressions.js';
import { takeName } from './names.js';
import { finishStatement } from './statements.js';
/**
 * `fn name(parameters) => body`, language.md 11.1.
 *
 * The body is an expression when it is written after the `=>` on one line, and
 * a block when the `=>` ends the line. Both forms exist because the one line
 * form needs the implicit return and an early exit needs the explicit one.
 *
 * The `=>` is two tokens. Section 3.12 does not list it among the punctuation,
 * so it arrives as an `=` and a `>` that touch, and touching is what tells it
 * from a comparison: the lexer suppresses its continuation rule for that exact
 * pair, and the same adjacency test is what matches it here.
 */
export function parseFunctionDeclaration(cursor) {
    const keyword = cursor.advance();
    const name = takeName(cursor);
    const open = cursor.take('(');
    if (open === undefined)
        cursor.unexpected(cursor.token);
    const parameters = open === undefined ? [] : parseBracketedList(cursor, open, parseParameter).items;
    const arrow = takeArrow(cursor);
    if (arrow === undefined) {
        return declaration(keyword, name, parameters, headerWithNoArrow(cursor, keyword));
    }
    if (!cursor.atStatementEnd()) {
        const body = parseExpression(cursor);
        finishStatement(cursor);
        return declaration(keyword, name, parameters, body);
    }
    finishStatement(cursor);
    return declaration(keyword, name, parameters, parseBlock(cursor, 'fn', keyword.span));
}
/**
 * A parameter, which is an ordinary identifier and not a label.
 *
 * `fn f(color = red)` is OS1019, and `plot(v, "V", color = aqua)` is not: the
 * body of a function refers to its parameters, and nothing ever refers to a
 * label (language.md 3.4). `takeName` is the whole of that difference.
 */
function parseParameter(cursor) {
    const name = takeName(cursor);
    const annotation = cursor.take(':') !== undefined ? parseTypeAnnotation(cursor) : undefined;
    const defaultValue = cursor.take('=') !== undefined ? parseExpression(cursor) : undefined;
    const end = defaultValue?.span ?? annotation?.span ?? name.span;
    return makeNode('parameter', spanning(name.span, end), { name, annotation, defaultValue });
}
/** The `=>` of 11.1: an `=` and a `>` written against each other. */
function takeArrow(cursor) {
    const equals = cursor.token;
    const greater = cursor.peek();
    if (equals.kind !== '=' || greater.kind !== '>')
        return undefined;
    if (equals.span.offset + equals.span.length !== greater.span.offset)
        return undefined;
    cursor.advance();
    return cursor.advance();
}
/**
 * A header with no `=>`, which the catalogue has no code of its own for.
 *
 * What is reported is what is true. A token sitting where the arrow belongs is
 * OS1018, whose fix names the operator that was meant to join the two halves. A
 * header that simply ends is OS1010, because that is what it now is: a header
 * with no body, since without the arrow the lexer opened no block under it.
 */
function headerWithNoArrow(cursor, keyword) {
    if (!cursor.atStatementEnd()) {
        cursor.unexpected(cursor.token);
        const body = parseExpression(cursor);
        finishStatement(cursor);
        return body;
    }
    cursor.report('OS1010', keyword.span, { header: 'fn' });
    finishStatement(cursor);
    if (cursor.at('indent'))
        return parseBlock(cursor, 'fn', keyword.span);
    return makeNode('block', cursor.holeSpan(), { statements: [] });
}
function declaration(keyword, name, parameters, body) {
    return makeNode('functionDeclaration', spanning(keyword.span, body.span), {
        name,
        parameters,
        body,
    });
}
//# sourceMappingURL=functions.js.map