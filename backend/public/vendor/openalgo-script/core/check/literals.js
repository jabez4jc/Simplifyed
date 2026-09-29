import { withoutGrouping } from '../ast/index.js';
export function literalNumber(expression) {
    if (expression === undefined)
        return undefined;
    const inner = withoutGrouping(expression);
    if (inner.kind === 'numberLiteral')
        return inner.value;
    if (inner.kind === 'unary' && (inner.operator === '-' || inner.operator === '+')) {
        const operand = literalNumber(inner.operand);
        if (operand === undefined)
            return undefined;
        return inner.operator === '-' ? -operand : operand;
    }
    return undefined;
}
export function literalString(expression) {
    if (expression === undefined)
        return undefined;
    const inner = withoutGrouping(expression);
    return inner.kind === 'stringLiteral' ? inner.value : undefined;
}
//# sourceMappingURL=literals.js.map