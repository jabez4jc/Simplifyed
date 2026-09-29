import { childrenOf, withoutGrouping } from '../ast/index.js';
export function namesGivenAValue(script) {
    const found = new Set();
    collect(script, found);
    return found;
}
function collect(node, found) {
    if (node.kind === 'assignment' && withoutGrouping(node.value).kind !== 'noneLiteral') {
        found.add(node.target.text);
    }
    for (const child of childrenOf(node))
        collect(child, found);
}
//# sourceMappingURL=assigned.js.map