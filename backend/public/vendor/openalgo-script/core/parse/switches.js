import { makeNode } from '../ast/index.js';
import { spanning } from '../span/index.js';
import { parseBlock } from './blocks.js';
import { parseCondition } from './expressions.js';
import { finishStatement } from './statements.js';
/**
 * `switch`, in both forms of language.md 10.6.
 *
 * With a subject each case value is compared against it, and without one each
 * case value is a condition. The difference is the absent subject and needs no
 * flag beside it.
 *
 * The arms are the whole of a switch body. A `default` that is not last would
 * leave the arms after it unreachable, so the arm that follows one is OS1017,
 * and the arm is kept in the tree all the same: a reader who moves the default
 * should not then be told about the arms one at a time.
 */
export function parseSwitchStatement(cursor) {
    const keyword = cursor.advance();
    const subject = cursor.atStatementEnd() ? undefined : parseCondition(cursor);
    finishStatement(cursor);
    const cases = [];
    let defaultCase;
    let end = keyword.span;
    if (!cursor.at('indent')) {
        if (!cursor.reportedHere)
            cursor.report('OS1010', keyword.span, { header: 'switch' });
        return makeNode('switchStatement', spanning(keyword.span, end), {
            subject,
            cases,
            defaultCase,
        });
    }
    if (!cursor.openBlock(cursor.token.span)) {
        cursor.skipBlockBody();
        return makeNode('switchStatement', spanning(keyword.span, end), {
            subject,
            cases,
            defaultCase,
        });
    }
    cursor.advance();
    while (!cursor.at('dedent') && !cursor.at('endOfFile')) {
        const before = cursor.position;
        const word = cursor.token;
        if (cursor.at('case')) {
            if (defaultCase !== undefined)
                cursor.report('OS1017', word.span, { word: word.text });
            const arm = parseCase(cursor);
            cases.push(arm);
            end = arm.span;
        }
        else if (cursor.at('default')) {
            const arm = parseDefault(cursor);
            if (defaultCase === undefined)
                defaultCase = arm;
            else
                cursor.report('OS1017', word.span, { word: word.text });
            end = arm.span;
        }
        else {
            // A line in a switch body that is not an arm. The catalogue has no code
            // for it, and OS1017 carries the rule it breaks: the arms are the whole
            // of the body, so this line belongs inside one of them or above the
            // switch.
            cursor.report('OS1017', word.span, { word: 'case' });
            cursor.skipStatement();
        }
        if (cursor.position === before)
            cursor.skipStatement();
    }
    cursor.closeBlock();
    cursor.take('dedent');
    return makeNode('switchStatement', spanning(keyword.span, end), { subject, cases, defaultCase });
}
/** One arm. Several values separated by commas are one arm, not several. */
function parseCase(cursor) {
    cursor.beginStatement();
    const keyword = cursor.advance();
    const values = [parseCondition(cursor)];
    while (cursor.take(',') !== undefined) {
        const before = cursor.position;
        values.push(parseCondition(cursor));
        if (cursor.position === before)
            break;
    }
    finishStatement(cursor);
    const body = parseBlock(cursor, 'case', keyword.span);
    return makeNode('switchCase', spanning(keyword.span, body.span), { values, body });
}
function parseDefault(cursor) {
    cursor.beginStatement();
    const keyword = cursor.advance();
    finishStatement(cursor);
    const body = parseBlock(cursor, 'default', keyword.span);
    return makeNode('switchDefault', spanning(keyword.span, body.span), { body });
}
//# sourceMappingURL=switches.js.map