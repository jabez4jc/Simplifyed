import { childrenOf } from '../ast/index.js';
/**
 * Every call site in the file that a bar can pass without evaluating.
 *
 * Calls rather than nodes, because a call site is what 11.4 is about and what
 * holds state. Kept as the nodes themselves rather than as spans, so the answer
 * cannot drift from the tree the checker is walking.
 */
export function conditionalCalls(script) {
    const found = new Set();
    collect(script, false, found);
    return found;
}
function collect(node, conditional, found) {
    if (conditional && node.kind === 'call')
        found.add(node);
    for (const child of childrenOf(node)) {
        const reach = reachOf(node, child);
        collect(child, reach === 'apart' ? false : conditional || reach === 'sometimes', found);
    }
}
function reachOf(node, child) {
    switch (node.kind) {
        // 9.5: only the taken arm is evaluated. Both arms and not only the true
        // one, because a stateful call in the false arm advances only on the bars
        // the condition failed, which is the same defect wearing the other sign.
        case 'ternary':
            return child === node.condition ? 'always' : 'sometimes';
        // 9.4: `and` and `or` evaluate the right operand only when it can change
        // the answer. Every other operator evaluates both sides.
        case 'binary':
            return child === node.right && (node.operator === 'and' || node.operator === 'or')
                ? 'sometimes'
                : 'always';
        // 10.2: the first branch is reached on every bar the `if` is, and a branch
        // after it only when every condition above it was false. A later condition
        // is inside that, which is why the whole branch is answered for here and
        // its body separately below.
        case 'ifStatement':
            return child === node.branches[0] ? 'always' : 'sometimes';
        case 'ifBranch':
            return child === node.condition ? 'always' : 'sometimes';
        case 'elseBranch':
            return 'always';
        // 10.6: the same shape. The subject is evaluated once and the first arm's
        // values are compared on every bar, but a later arm is reached only when
        // nothing above it matched. Values within one arm are all evaluated.
        case 'switchStatement':
            return child === node.subject || child === node.cases[0] ? 'always' : 'sometimes';
        case 'switchCase':
            return child === node.body ? 'sometimes' : 'always';
        case 'switchDefault':
            return 'always';
        // 10.3 and 10.4: a loop body may run no times at all, and what decides how
        // many times it runs is evaluated before it does.
        case 'forRangeStatement':
        case 'forInStatement':
        case 'whileStatement':
            return child === node.body ? 'sometimes' : 'always';
        // 11.4: state is allocated per call site, so the calls in a body belong to
        // whoever calls the function.
        case 'functionDeclaration':
            return 'apart';
        // Everything else evaluates every child it has, every time it is reached.
        // A call evaluates each of its arguments, including the expression a `req`
        // reads, which runs on every bar of the series it is read against.
        case 'script':
        case 'parameter':
        case 'versionLine':
        case 'scriptDeclaration':
        case 'limitsLine':
        case 'block':
        case 'expressionStatement':
        case 'assignment':
        case 'varDeclaration':
        case 'breakStatement':
        case 'continueStatement':
        case 'returnStatement':
        case 'numberLiteral':
        case 'stringLiteral':
        case 'booleanLiteral':
        case 'colorLiteral':
        case 'noneLiteral':
        case 'nameReference':
        case 'missingExpression':
        case 'arrayLiteral':
        case 'grouping':
        case 'unary':
        case 'call':
        case 'argument':
        case 'index':
        case 'member':
        case 'namedType':
        case 'seriesType':
        case 'arrayType':
        case 'name':
            return 'always';
    }
}
//# sourceMappingURL=conditional.js.map