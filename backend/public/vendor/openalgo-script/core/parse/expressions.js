import { COMPARISON_OPERATORS, EQUALITY_OPERATORS, UNARY_OPERATORS, makeNode, } from '../ast/index.js';
import { spanning } from '../span/index.js';
import { describeToken } from './cursor.js';
import { atLabel, isMeantAsAName, takeLabel, takeMember, takeName } from './names.js';
/**
 * The expression grammar, which is the precedence table of language.md 9.1 read
 * from the bottom up.
 *
 * One function per level, in the order the table lists them, so the table can
 * be checked against this file line by line. Precedence ends up in the shape of
 * the tree rather than in a field, which is why nothing downstream ever has to
 * know that `*` binds tighter than `+`.
 *
 * Two levels are deliberately not loops. Comparison and equality take at most
 * one operator, because `a < b < c` has two plausible readings and the language
 * refuses both (9.3). They are written as loops all the same, so that the
 * second operator is reported as OS1008 with a caret on it and the expression
 * still builds, rather than the parser stopping at a shape it cannot hold.
 */
const ADDITIVE = ['+', '-'];
const MULTIPLICATIVE = ['*', '/', '%'];
/** The tokens an expression can begin with, which is what tells two arguments apart. */
const STARTS_EXPRESSION = new Set([
    'numberLiteral',
    'stringLiteral',
    'hexColor',
    'identifier',
    'true',
    'false',
    'none',
    '(',
    '[',
    '-',
    '+',
    'not',
]);
/**
 * Whether an expression can begin here, which is what tells one argument from
 * the next and what keeps a list from reading a closing bracket as an item.
 *
 * A reserved word a reader meant as a name begins one too, because `parsePrimary`
 * reads it as the name it was meant to be rather than leaving it where it sits.
 */
export function startsExpression(kind) {
    return STARTS_EXPRESSION.has(kind) || isMeantAsAName(kind);
}
export function parseExpression(cursor) {
    if (!cursor.deeper(cursor.token.span))
        return missingExpression(cursor);
    const expression = parseTernary(cursor);
    cursor.shallower();
    return expression;
}
/**
 * An expression in a position where a value is being tested rather than stored.
 *
 * `if x = 5` is the one typo the language is shaped to catch: assignment is a
 * statement and never an expression (10.1), so there is no reading of the line
 * that compiles, and OS1006 can name the fix instead of a type error arriving
 * three stages later. The `==` is built as though the fix had been applied, so
 * the rest of the file still checks.
 */
export function parseCondition(cursor) {
    const condition = parseExpression(cursor);
    const assign = cursor.take('=');
    if (assign === undefined)
        return condition;
    cursor.report('OS1006', assign.span, {});
    const right = parseExpression(cursor);
    return makeNode('binary', spanning(condition.span, right.span), {
        operator: '==',
        left: condition,
        right,
    });
}
function parseTernary(cursor) {
    const condition = parseOr(cursor);
    const question = cursor.take('?');
    if (question === undefined)
        return condition;
    const whenTrue = parseExpression(cursor);
    if (cursor.take(':') === undefined) {
        cursor.report('OS1015', question.span, {});
        const hole = missingExpression(cursor);
        return makeNode('ternary', spanning(condition.span, whenTrue.span), {
            condition,
            whenTrue,
            whenFalse: hole,
        });
    }
    // Right associative (9.1): the false arm takes the rest of the line, so
    // `x > 0 ? "up" : x < 0 ? "down" : "flat"` nests to the right.
    const whenFalse = parseExpression(cursor);
    return makeNode('ternary', spanning(condition.span, whenFalse.span), {
        condition,
        whenTrue,
        whenFalse,
    });
}
function parseOr(cursor) {
    let left = parseAnd(cursor);
    while (cursor.take('or') !== undefined) {
        const right = parseAnd(cursor);
        left = makeNode('binary', spanning(left.span, right.span), { operator: 'or', left, right });
    }
    return left;
}
function parseAnd(cursor) {
    let left = parseEquality(cursor);
    while (cursor.take('and') !== undefined) {
        const right = parseEquality(cursor);
        left = makeNode('binary', spanning(left.span, right.span), { operator: 'and', left, right });
    }
    return left;
}
function parseEquality(cursor) {
    return parseUnchainable(cursor, EQUALITY_OPERATORS, parseComparison);
}
function parseComparison(cursor) {
    return parseUnchainable(cursor, COMPARISON_OPERATORS, parseAdditive);
}
/**
 * A level that takes at most one operator, and says so when it is given two.
 *
 * The chain is folded to the left after the report so that the tree holds
 * everything the reader wrote. A parser that stopped here would leave the rest
 * of the line unparsed, and the reader would fix the chain only to be told
 * about the next mistake on the same line one compile later.
 */
function parseUnchainable(cursor, operators, next) {
    let left = next(cursor);
    let first;
    let chained = false;
    for (;;) {
        const operator = operatorAt(cursor, operators);
        if (operator === undefined)
            return left;
        const token = cursor.advance();
        if (first !== undefined && !chained) {
            chained = true;
            cursor.report('OS1008', token.span, { op1: first, op2: operator });
        }
        first ??= operator;
        const right = next(cursor);
        left = makeNode('binary', spanning(left.span, right.span), { operator, left, right });
    }
}
function parseAdditive(cursor) {
    return parseLeftAssociative(cursor, ADDITIVE, parseMultiplicative);
}
function parseMultiplicative(cursor) {
    return parseLeftAssociative(cursor, MULTIPLICATIVE, parseUnary);
}
function parseLeftAssociative(cursor, operators, next) {
    let left = next(cursor);
    for (;;) {
        const operator = operatorAt(cursor, operators);
        if (operator === undefined)
            return left;
        cursor.advance();
        const right = next(cursor);
        left = makeNode('binary', spanning(left.span, right.span), { operator, left, right });
    }
}
/**
 * Unary minus, plus and `not`, right associative.
 *
 * Section 19 writes this level as taking at most one operator. The prose wins:
 * 9.1 calls it right associative, so `not not ready` and `- -x` are shapes the
 * tree can hold and the checker can have an opinion about.
 */
function parseUnary(cursor) {
    const operator = operatorAt(cursor, UNARY_OPERATORS);
    if (operator === undefined)
        return parsePostfix(cursor);
    const token = cursor.advance();
    if (!cursor.deeper(token.span))
        return missingExpression(cursor);
    const operand = parseUnary(cursor);
    cursor.shallower();
    return makeNode('unary', spanning(token.span, operand.span), { operator, operand });
}
/** A call, a history or element read, and a member, applied left to right. */
function parsePostfix(cursor) {
    let target = parsePrimary(cursor);
    for (;;) {
        const before = cursor.position;
        if (cursor.at('(')) {
            const open = cursor.advance();
            const args = parseBracketedList(cursor, open, parseArgument);
            target = makeNode('call', spanning(target.span, args.end), {
                callee: target,
                args: args.items,
            });
        }
        else if (cursor.at('[')) {
            const open = cursor.advance();
            const index = parseExpression(cursor);
            const end = closeBracket(cursor, open);
            target = makeNode('index', spanning(target.span, end), { target, index });
        }
        else if (cursor.at('.')) {
            cursor.advance();
            const member = takeMember(cursor);
            target = makeNode('member', spanning(target.span, member.span), { object: target, member });
        }
        else {
            return target;
        }
        if (cursor.position === before)
            return target;
    }
}
function parsePrimary(cursor) {
    const token = cursor.token;
    switch (token.kind) {
        case 'numberLiteral':
            cursor.advance();
            return makeNode('numberLiteral', token.span, { value: token.value });
        case 'stringLiteral':
            cursor.advance();
            return makeNode('stringLiteral', token.span, { value: token.value });
        case 'true':
        case 'false':
            cursor.advance();
            return makeNode('booleanLiteral', token.span, { value: token.kind === 'true' });
        case 'none':
            cursor.advance();
            return makeNode('noneLiteral', token.span, {});
        // Only `#rrggbb` and `#rrggbbaa`. A named colour is an ordinary global
        // (3.8), so `aqua` arrives here as an identifier and leaves as a reference.
        case 'hexColor':
            cursor.advance();
            return makeNode('colorLiteral', token.span, { text: token.text });
        case 'identifier':
            cursor.advance();
            return makeNode('nameReference', token.span, { name: token.text });
        case '(': {
            cursor.advance();
            const inner = parseExpression(cursor);
            const end = closeBracket(cursor, token);
            return makeNode('grouping', spanning(token.span, end), { expression: inner });
        }
        case '[': {
            cursor.advance();
            const elements = parseBracketedList(cursor, token, parseExpression);
            return makeNode('arrayLiteral', spanning(token.span, elements.end), {
                elements: elements.items,
            });
        }
        default:
            // A reserved word where a value belongs is the name the reader meant, and
            // OS1019 says the language has taken the word. The word is taken here as
            // well as reported on: a rule that reports and then consumes nothing
            // leaves the list and the bracket above it looking at the token it could
            // not read, and the next thing the reader is told is that a bracket they
            // plainly closed was never closed.
            if (isMeantAsAName(token.kind)) {
                const name = takeName(cursor, true);
                return makeNode('nameReference', name.span, { name: name.text });
            }
            return expressionExpected(cursor);
    }
}
/** One argument, with the label of a named one when there is a label. */
function parseArgument(cursor) {
    if (!atLabel(cursor)) {
        const bare = parseExpression(cursor);
        return makeNode('argument', bare.span, { label: undefined, value: bare });
    }
    const label = takeLabel(cursor);
    cursor.advance();
    const value = parseExpression(cursor);
    return makeNode('argument', spanning(label.span, value.span), { label, value });
}
/**
 * A comma separated list inside brackets: an argument list or an array literal.
 *
 * The two shapes are one function because their recovery is the same and has to
 * stay the same: a missing comma is OS1014 and the list carries on, and a list
 * that runs to the end of the line without a closer is the bracket's own error
 * rather than one per item.
 */
export function parseBracketedList(cursor, open, parseItem) {
    const items = [];
    for (;;) {
        if (atListEnd(cursor))
            break;
        const before = cursor.position;
        items.push(parseItem(cursor));
        const comma = cursor.take(',');
        if (comma !== undefined) {
            if (!atListEnd(cursor))
                continue;
            // A comma promises another item (3.11 continues the line for one), so a
            // list that ends on one has lost it rather than written an empty slot.
            cursor.report('OS1022', cursor.holeSpan(), { token: describeToken(comma) });
            break;
        }
        if (atListEnd(cursor))
            break;
        // The item read nothing, so it has reported its own hole and the token it
        // could not read is still here. Taking it carries the list on to the item
        // after it and, more importantly, to the closing bracket: a list that
        // stopped here would hand the bracket a token that is not a closer, and the
        // reader would be told the bracket was never closed on a line that closes
        // it.
        if (cursor.position === before) {
            cursor.advance();
            continue;
        }
        // What follows could not have begun a second item, so this is the closing
        // bracket's mistake and not a missing comma.
        if (!startsExpression(cursor.kind))
            break;
        cursor.report('OS1014', cursor.token.span, { token: describeToken(cursor.token) });
    }
    return { items, end: closeBracket(cursor, open) };
}
function atListEnd(cursor) {
    return cursor.at(')') || cursor.at(']') || cursor.atStatementEnd();
}
/**
 * The closing bracket, or the two ways it can be missing.
 *
 * OS1012 is reported at the opening bracket rather than at the end of the file,
 * because an open bracket continues the statement onto every following line
 * (3.11) and the mistake is where the bracket was opened.
 */
export function closeBracket(cursor, open) {
    const expected = open.kind === '(' ? ')' : ']';
    const closer = cursor.take(expected);
    if (closer !== undefined)
        return closer.span;
    if (cursor.at(')') || cursor.at(']')) {
        const found = cursor.advance();
        cursor.report('OS1013', found.span, {
            found: found.text,
            expected,
            opener: open.text,
            line: open.span.line,
        });
        return found.span;
    }
    cursor.report('OS1012', open.span, { bracket: open.text, line: open.span.line });
    return cursor.previous().span;
}
function expressionExpected(cursor) {
    const hole = cursor.holeSpan();
    cursor.report('OS1022', hole, {
        token: describeToken(cursor.previousMeaningful() ?? cursor.token),
    });
    return makeNode('missingExpression', hole, {});
}
/**
 * The hole a rule leaves where an expression was required.
 *
 * The span is empty and sits where the expression should have been, so it never
 * takes a caret meant for its neighbour, and everything downstream still has a
 * tree to walk over a file that is being typed.
 */
export function missingExpression(cursor) {
    return makeNode('missingExpression', cursor.holeSpan(), {});
}
function operatorAt(cursor, operators) {
    const kind = cursor.kind;
    return operators.includes(kind) ? kind : undefined;
}
/** An argument list, for the three statements that are a call in all but name. */
export function parseArgumentList(cursor, open) {
    return parseBracketedList(cursor, open, parseArgument);
}
//# sourceMappingURL=expressions.js.map