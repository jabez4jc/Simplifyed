import { UNKNOWN, typeText } from './types.js';
/**
 * What a position holds when it requires a value and fixes no type of its own.
 *
 * A `var`, a ternary arm, a `return` and an operand of `==` all want one value
 * per bar and take any type. What they cannot take is the one thing that has no
 * per-bar value at all, and that is the sentence OS2003 has to say.
 */
const PER_BAR_VALUE = 'a per-bar value';
/**
 * Marks an expression as one of the places 5.4 lets a handle be written.
 *
 * Grouping is transparent to every rule in the language, so `(upper)` is
 * permitted wherever `upper` is and each layer is marked.
 */
export function allowHandle(checker, expression) {
    let node = expression;
    for (;;) {
        checker.handleSites.add(node);
        if (node.kind !== 'grouping')
            return;
        node = node.expression;
    }
}
/** Whether a handle written here has been permitted by one of the three rules. */
export function handleAllowed(checker, expression) {
    return checker.handleSites.has(expression);
}
/**
 * OS2003 for a handle in a position that requires a value, `language.md` 5.4.
 *
 * The expression is left `unknown` rather than left as a handle, so the rule
 * above it does not report a second time and the emitter is never handed a
 * handle to find a register for.
 */
export function refuseHandle(checker, expression, type) {
    checker.report('OS2003', expression.span, {
        leftType: PER_BAR_VALUE,
        rightType: typeText(type),
    });
    return checker.record(expression, UNKNOWN, checker.warmupOf(expression));
}
//# sourceMappingURL=handles.js.map