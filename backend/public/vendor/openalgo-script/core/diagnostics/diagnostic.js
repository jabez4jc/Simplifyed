import { entryFor, fillTemplate } from '../catalogue/index.js';
/**
 * Builds a diagnostic.
 *
 * The values argument is typed per code, so a call site that forgets a slot or
 * misspells one fails to compile. That is the only guard that runs before a
 * trader sees the message, which is why the placeholders are generated as types.
 */
export function diagnosticFor(code, span, values) {
    const entry = entryFor(code);
    // DiagnosticValues is generated with every property typed PlaceholderValue,
    // so this widening loses the per-code shape and nothing else.
    const supplied = values;
    return {
        code,
        severity: entry.severity,
        stage: entry.stage,
        title: entry.title,
        message: fillTemplate(entry.message, supplied),
        fix: fillTemplate(entry.fix, supplied),
        autofix: entry.autofix,
        span,
        values: supplied,
    };
}
export function isError(diagnostic) {
    return diagnostic.severity === 'error';
}
//# sourceMappingURL=diagnostic.js.map