export function makeSpan(offset, length, line, column) {
    return { offset, length, line, column };
}
/** One past the last code unit the span covers. */
export function endOffset(span) {
    return span.offset + span.length;
}
/**
 * The span from the start of the first to the end of the last.
 *
 * This is how a node gets a span: a call expression runs from its callee to its
 * closing bracket, and the caret under it covers the whole call rather than the
 * one token the parser happened to be holding.
 */
export function spanning(first, last) {
    return {
        offset: first.offset,
        length: Math.max(endOffset(last) - first.offset, 0),
        line: first.line,
        column: first.column,
    };
}
/** Whether an offset falls inside the span. A zero length span contains nothing. */
export function containsOffset(span, offset) {
    return offset >= span.offset && offset < endOffset(span);
}
//# sourceMappingURL=span.js.map