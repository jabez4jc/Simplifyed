/** `ta.sma` for a member chain of plain names, and undefined for anything else. */
export function pathOf(expr) {
    if (expr.kind === 'name')
        return expr.name;
    if (expr.kind !== 'member')
        return undefined;
    const base = pathOf(expr.object);
    return base === undefined ? undefined : `${base}.${expr.property}`;
}
/** The place covering two places and everything between them. */
export function joined(first, last) {
    return { offset: first.offset, length: Math.max(last.offset + last.length - first.offset, 0) };
}
//# sourceMappingURL=syntax.js.map