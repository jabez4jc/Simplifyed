import { childrenOf, withoutGrouping } from '../ast/index.js';
import { elementOf } from './types.js';
/** The calls that take an element out of an array or empty it, `language.md` 14.1. */
const REMOVING = new Set(['shift', 'pop', 'remove', 'clear']);
export function reportDeletedStillHeld(checker) {
    // One walk of the whole tree, paid only by a file that deletes something.
    if (!checker.calls.some((one) => one.name === 'draw.delete'))
        return;
    visit(checker, checker.script);
}
function visit(checker, node) {
    if (node.kind === 'script' || node.kind === 'block') {
        reportList(checker, statementsOf(node));
    }
    for (const child of childrenOf(node))
        visit(checker, child);
}
function statementsOf(node) {
    return node.kind === 'script' ? node.items : node.statements;
}
function reportList(checker, statements) {
    statements.forEach((statement, index) => {
        const call = deleteCall(checker, statement);
        if (call === undefined)
            return;
        const argument = call.args[0]?.value;
        if (argument === undefined)
            return;
        const held = heldBy(checker, argument);
        if (held === undefined)
            return;
        const kind = objectKindOf(checker, argument);
        if (kind === undefined)
            return;
        const later = statements.slice(index + 1);
        const cleared = held.inArray
            ? later.some((one) => removesFrom(checker, one, held.binding))
            : later.some((one) => assigns(one, held.binding.name));
        if (cleared)
            return;
        checker.report('OS8019', argument.span, {
            name: held.binding.name,
            kind,
            line: call.span.line,
        });
    });
}
/** The `draw.delete(...)` a statement is, when it is one. */
function deleteCall(checker, statement) {
    if (statement.kind !== 'expressionStatement')
        return undefined;
    const expression = withoutGrouping(statement.expression);
    if (expression.kind !== 'call')
        return undefined;
    return checker.callSites.get(expression)?.name === 'draw.delete' ? expression : undefined;
}
/** The persistent name the deleted object is still reachable through. */
function heldBy(checker, argument) {
    const written = withoutGrouping(argument);
    if (written.kind === 'nameReference') {
        const binding = persistent(checker, written);
        return binding === undefined ? undefined : { binding, inArray: false };
    }
    const array = arrayOf(checker, written);
    if (array === undefined)
        return undefined;
    const binding = persistent(checker, array);
    return binding === undefined ? undefined : { binding, inArray: true };
}
/** `element(arr, i)` or `arr[i]`, as the array expression it reads. */
function arrayOf(checker, written) {
    if (written.kind === 'index')
        return withoutGrouping(written.target);
    if (written.kind === 'call' && checker.callSites.get(written)?.name === 'element') {
        const first = written.args[0]?.value;
        return first === undefined ? undefined : withoutGrouping(first);
    }
    return undefined;
}
function persistent(checker, expression) {
    if (expression.kind !== 'nameReference')
        return undefined;
    const binding = checker.references.get(expression);
    return binding !== undefined && binding.persistence !== 'none' ? binding : undefined;
}
function objectKindOf(checker, argument) {
    const type = checker.types.get(argument);
    if (type === undefined)
        return undefined;
    const element = elementOf(type);
    return element.kind === 'object' ? element.object : undefined;
}
function assigns(statement, name) {
    return statement.kind === 'assignment' && statement.target.text === name;
}
/** Whether any call in the statement takes an element out of this array. */
function removesFrom(checker, node, binding) {
    if (node.kind === 'call') {
        const name = checker.callSites.get(node)?.name;
        const first = node.args[0]?.value;
        if (name !== undefined && REMOVING.has(name) && first !== undefined) {
            const target = withoutGrouping(first);
            if (target.kind === 'nameReference' && checker.references.get(target) === binding)
                return true;
        }
    }
    return childrenOf(node).some((child) => removesFrom(checker, child, binding));
}
//# sourceMappingURL=deleted.js.map