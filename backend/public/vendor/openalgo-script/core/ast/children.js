const NO_CHILDREN = [];
/** The nodes among these that are there, keeping the order they were given in. */
function present(...nodes) {
    return nodes.filter((node) => node !== undefined);
}
/**
 * The children of a node, in source order.
 *
 * This is the only place the shape of the tree is written down twice, and it is
 * deliberately the only one. Everything that walks the tree walks it through
 * here, so a field added to a node is connected once and every pass sees it,
 * rather than being connected in the checker, forgotten in the code generator,
 * and found by a user whose script compiled to something with a hole in it.
 *
 * The switch has no default arm on purpose: a new node kind stops the build
 * here, at the one place that has to know about it.
 */
export function childrenOf(node) {
    switch (node.kind) {
        // The file and what only the file holds.
        case 'script':
            return node.items;
        case 'functionDeclaration':
            return [node.name, ...node.parameters, node.body];
        case 'parameter':
            return present(node.name, node.annotation, node.defaultValue);
        // The header lines, which are statements wherever they are written.
        case 'versionLine':
            return [node.version];
        case 'scriptDeclaration':
            return node.args;
        case 'limitsLine':
            return node.args;
        // Statements.
        case 'expressionStatement':
            return [node.expression];
        case 'assignment':
            return [node.target, node.value];
        case 'varDeclaration':
            return present(node.name, node.annotation, node.initialiser);
        case 'ifStatement':
            return present(...node.branches, node.elseBranch);
        case 'ifBranch':
            return [node.condition, node.body];
        case 'elseBranch':
            return [node.body];
        case 'forRangeStatement':
            return present(node.variable, node.from, node.to, node.step, node.body);
        case 'forInStatement':
            return [node.variable, node.iterable, node.body];
        case 'whileStatement':
            return [node.condition, node.body];
        case 'switchStatement':
            return present(node.subject, ...node.cases, node.defaultCase);
        case 'switchCase':
            return [...node.values, node.body];
        case 'switchDefault':
            return [node.body];
        case 'breakStatement':
        case 'continueStatement':
            return NO_CHILDREN;
        case 'returnStatement':
            return present(node.value);
        case 'block':
            return node.statements;
        // Expressions.
        case 'numberLiteral':
        case 'stringLiteral':
        case 'booleanLiteral':
        case 'colorLiteral':
        case 'noneLiteral':
        case 'nameReference':
        case 'missingExpression':
            return NO_CHILDREN;
        case 'arrayLiteral':
            return node.elements;
        case 'grouping':
            return [node.expression];
        case 'unary':
            return [node.operand];
        case 'binary':
            return [node.left, node.right];
        case 'ternary':
            return [node.condition, node.whenTrue, node.whenFalse];
        case 'call':
            return [node.callee, ...node.args];
        case 'argument':
            return present(node.label, node.value);
        case 'index':
            return [node.target, node.index];
        case 'member':
            return [node.object, node.member];
        // Type annotations, and a name where one is written.
        case 'namedType':
            return NO_CHILDREN;
        case 'seriesType':
        case 'arrayType':
            return [node.element];
        case 'name':
            return NO_CHILDREN;
    }
}
//# sourceMappingURL=children.js.map