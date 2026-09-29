import { makeNode } from '../ast/index.js';
import { spanning } from '../span/index.js';
import { parseStatement } from './statements.js';
/**
 * The indented lines under a header, language.md 3.10.
 *
 * The lexer has already decided where a block begins and ends, so this reads an
 * `indent`, statements, and a `dedent`, and the one rule it owns is what to do
 * when the `indent` is not there: OS1010, reported against the header rather
 * than against the line that failed to be a body, because the header is what
 * the reader has to change.
 *
 * The statement loop insists on progress. A rule that reports without consuming
 * anything would otherwise spin on the token it could not read, and a compiler
 * that hangs on a malformed file is worse than one that gives up on it.
 */
export function parseBlock(cursor, header, at) {
    if (!cursor.at('indent')) {
        // A header that was already reported on has nothing to add by saying its
        // body is missing too: the body is missing because of what it was told.
        if (!cursor.reportedHere)
            cursor.report('OS1010', at, { header });
        const hole = cursor.holeSpan();
        return makeNode('block', hole, { statements: [] });
    }
    if (!cursor.openBlock(cursor.token.span)) {
        const span = cursor.token.span;
        cursor.skipBlockBody();
        return makeNode('block', span, { statements: [] });
    }
    const indent = cursor.advance();
    const statements = [];
    while (!cursor.at('dedent') && !cursor.at('endOfFile')) {
        const before = cursor.position;
        const statement = parseStatement(cursor);
        if (statement !== undefined)
            statements.push(statement);
        if (cursor.position === before)
            cursor.skipStatement();
    }
    cursor.closeBlock();
    cursor.take('dedent');
    const last = statements[statements.length - 1];
    const span = last === undefined ? indent.span : spanning(indent.span, last.span);
    return makeNode('block', span, { statements });
}
//# sourceMappingURL=blocks.js.map