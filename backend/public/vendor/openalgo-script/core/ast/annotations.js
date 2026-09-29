/**
 * A type as a script writes it, on a parameter, a `var` or a function result.
 *
 * The tree keeps the words rather than a resolved type. A resolved type is the
 * checker's, it has no source position, and it exists for expressions that were
 * never annotated at all; an annotation is a piece of syntax with a span that a
 * caret can land on.
 */
/** The types a value can have, language.md 5.1. */
export const VALUE_TYPE_NAMES = ['number', 'string', 'bool', 'color'];
/**
 * The runtime object types of language.md 5.4.
 *
 * These five are recognised in a type position only and are ordinary global
 * function names everywhere else, which is why they are not reserved words. The
 * declaration handle types `plot`, `fill` and `level` are deliberately missing:
 * a handle can never be a `var`, a parameter, a result or an array element, so
 * it can never be annotated.
 */
export const OBJECT_TYPE_NAMES = ['line', 'label', 'box', 'polyline', 'table'];
export function isValueTypeName(text) {
    return VALUE_TYPE_NAMES.includes(text);
}
export function isObjectTypeName(text) {
    return OBJECT_TYPE_NAMES.includes(text);
}
//# sourceMappingURL=annotations.js.map