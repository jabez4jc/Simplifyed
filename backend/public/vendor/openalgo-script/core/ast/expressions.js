/**
 * Every expression form of language.md section 9.
 *
 * Precedence is not a field anywhere below. It is in the shape of the tree: the
 * parser reads the levels of 9.1 and the result is already grouped, so a later
 * pass never has to know that `*` binds tighter than `+`. The one thing the
 * tree does keep is the brackets a script wrote, because they are the
 * difference between a caret under `(a < b)` and a caret under a whole line.
 */
export const ARITHMETIC_OPERATORS = ['+', '-', '*', '/', '%'];
export const COMPARISON_OPERATORS = ['<', '<=', '>', '>='];
export const EQUALITY_OPERATORS = ['==', '!='];
export const LOGICAL_OPERATORS = ['and', 'or'];
export const UNARY_OPERATORS = ['-', '+', 'not'];
/**
 * The level each binary operator sits at in language.md 9.1, where a lower
 * number binds more tightly.
 *
 * The numbers are the specification's own rather than a private scale that runs
 * the other way, so a reader can check this table against language.md 9.1
 * without translating it as they read. It sits next to the operators because a
 * parser and a formatter that each kept a copy would disagree about one
 * operator eventually, and that disagreement reaches a chart as a wrong number.
 */
const BINARY_PRECEDENCE = {
    '*': 3,
    '/': 3,
    '%': 3,
    '+': 4,
    '-': 4,
    '<': 5,
    '<=': 5,
    '>': 5,
    '>=': 5,
    '==': 6,
    '!=': 6,
    and: 7,
    or: 8,
};
export function binaryPrecedence(operator) {
    return BINARY_PRECEDENCE[operator];
}
/** The expression inside however many brackets were written around it. */
export function withoutGrouping(expression) {
    let inner = expression;
    while (inner.kind === 'grouping')
        inner = inner.expression;
    return inner;
}
//# sourceMappingURL=expressions.js.map