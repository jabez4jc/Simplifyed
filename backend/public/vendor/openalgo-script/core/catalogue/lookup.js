import { ENTRIES } from './catalogue.generated.js';
/** What a code says. The argument type means there is no missing case. */
export function entryFor(code) {
    return ENTRIES[code];
}
/**
 * Whether a string is a code this compiler knows.
 *
 * A host reading a code out of a saved report or a log has a string, not a
 * DiagnosticCode, and this is the one place that turns one into the other.
 */
export function isDiagnosticCode(text) {
    return Object.hasOwn(ENTRIES, text);
}
/** Every code, ascending. */
export function allCodes() {
    return Object.keys(ENTRIES);
}
//# sourceMappingURL=lookup.js.map