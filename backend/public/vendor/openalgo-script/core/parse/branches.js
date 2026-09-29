import { makeNode } from '../ast/index.js';
import { spanning } from '../span/index.js';
import { parseBlock } from './blocks.js';
import { parseCondition } from './expressions.js';
import { finishStatement } from './statements.js';
/**
 * `if`, `else if` and `else`, language.md 10.2.
 *
 * The branches are kept beside each other rather than nested, because `else if`
 * is two words on one line and does not increase indentation, so a reader sees
 * one statement with several arms and every pass over the tree should see the
 * same thing.
 *
 * An `else` pairs with the `if` at its own indentation. The lexer has already
 * closed the blocks between them, so the `else` that arrives here is the one
 * that belongs to this `if`; what is left to check is that the two line up, and
 * OS1016 when they do not.
 */
export function parseIfStatement(cursor) {
    const keyword = cursor.token;
    cursor.noteIf(keyword.span.column);
    const branches = [parseBranch(cursor, 'if', keyword.span)];
    let elseBranch;
    let end = branches[0]?.span ?? keyword.span;
    while (cursor.at('else')) {
        const word = cursor.token;
        pairWithIf(cursor, word, keyword);
        cursor.advance();
        if (cursor.at('if')) {
            const branch = parseBranch(cursor, 'else if', word.span);
            branches.push(branch);
            end = branch.span;
            continue;
        }
        elseBranch = parseElse(cursor, word);
        end = elseBranch.span;
        break;
    }
    return makeNode('ifStatement', spanning(keyword.span, end), { branches, elseBranch });
}
/** One `if` or `else if` header and the block under it. */
function parseBranch(cursor, header, start) {
    cursor.beginStatement();
    const keyword = cursor.advance();
    const condition = parseCondition(cursor);
    finishStatement(cursor);
    const body = parseBlock(cursor, header, spanning(start, keyword.span));
    return makeNode('ifBranch', spanning(start, body.span), { condition, body });
}
function parseElse(cursor, word) {
    cursor.beginStatement();
    // Nothing may follow `else` on its line: there is no statement separator to
    // end a one line body with, so a body is written indented underneath.
    finishStatement(cursor);
    const body = parseBlock(cursor, 'else', word.span);
    return makeNode('elseBranch', spanning(word.span, body.span), { body });
}
function pairWithIf(cursor, word, keyword) {
    if (word.span.column === keyword.span.column)
        return;
    cursor.report('OS1016', word.span, {
        found: word.span.column - 1,
        expected: keyword.span.column - 1,
    });
}
//# sourceMappingURL=branches.js.map