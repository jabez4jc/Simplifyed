import { makeNode } from '../ast/index.js';
import { spanning } from '../span/index.js';
import { parseBlock } from './blocks.js';
import { describeToken } from './cursor.js';
import { missingExpression, parseCondition, parseExpression } from './expressions.js';
import { takeName } from './names.js';
import { finishStatement } from './statements.js';
/**
 * `for` and `while`, language.md 10.3 and 10.4.
 *
 * There are two loop forms and no third, so a header that is neither is OS1020
 * rather than a cascade of smaller complaints: the message names the two shapes
 * that exist, which is the only thing the reader needs. The body is read either
 * way, so the lines under a header that was not understood are still checked.
 */
export function parseForStatement(cursor) {
    const keyword = cursor.advance();
    const variable = takeName(cursor);
    if (cursor.take('in') !== undefined) {
        const iterable = parseExpression(cursor);
        const body = readBody(cursor, keyword);
        return makeNode('forInStatement', spanning(keyword.span, body.span), {
            variable,
            iterable,
            body,
        });
    }
    if (cursor.take('=') === undefined) {
        incompleteHeader(cursor);
        return range(cursor, keyword, variable, missingExpression(cursor), missingExpression(cursor));
    }
    const from = parseExpression(cursor);
    if (cursor.take('to') === undefined) {
        incompleteHeader(cursor);
        return range(cursor, keyword, variable, from, missingExpression(cursor));
    }
    const to = parseExpression(cursor);
    // A missing `step` is one rather than a node the reader did not write, so
    // OS3004 on a step of zero always has a span to point at (10.3).
    const step = cursor.take('step') !== undefined ? parseExpression(cursor) : undefined;
    return range(cursor, keyword, variable, from, to, step);
}
export function parseWhileStatement(cursor) {
    const keyword = cursor.advance();
    const condition = parseCondition(cursor);
    const body = readBody(cursor, keyword);
    return makeNode('whileStatement', spanning(keyword.span, body.span), { condition, body });
}
function range(cursor, keyword, variable, from, to, step) {
    const body = readBody(cursor, keyword);
    return makeNode('forRangeStatement', spanning(keyword.span, body.span), {
        variable,
        from,
        to,
        step,
        body,
    });
}
/**
 * The block under a loop header, with the loop counted while it is read.
 *
 * The count is what `break` and `continue` ask about, so it has to go up before
 * the body is parsed and down after it, including on the paths where the header
 * itself was not understood: a `break` inside a broken `for` is still inside a
 * loop, and reporting OS1009 on it would be a second complaint about the first
 * mistake.
 */
function readBody(cursor, keyword) {
    finishStatement(cursor);
    cursor.enterLoop();
    const body = parseBlock(cursor, keyword.text, keyword.span);
    cursor.leaveLoop();
    return body;
}
function incompleteHeader(cursor) {
    cursor.report('OS1020', cursor.token.span, { token: describeToken(cursor.token) });
}
//# sourceMappingURL=loops.js.map