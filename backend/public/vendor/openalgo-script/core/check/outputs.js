import { literalString } from './literals.js';
const OUTPUT_FORMS = new Set(['plot', 'plotCandles', 'fill', 'level', 'table']);
export function recordOutput(checker, entry, checked) {
    if (!OUTPUT_FORMS.has(entry.name))
        return;
    const form = entry.name;
    const title = literalString(argumentFor(entry, checked, 'title')?.value) ?? '';
    const value = argumentFor(entry, checked, 'value') ?? argumentFor(entry, checked, 'price');
    const warmup = value === undefined ? checked.warmup : checker.warmupOf(value.value);
    checker.outputs.push({
        id: checker.outputs.length,
        form,
        title,
        call: checked.call,
        warmup,
        span: checked.call.span,
    });
    // A column whose value is absent on every bar draws nothing at all, and a
    // reader deserves to know that before they run the study and wonder why.
    if ((form === 'plot' || form === 'plotCandles') && warmup.kind === 'never') {
        checker.report('OS8009', checked.call.span, { title: quoted(title) });
    }
}
export function reportCallWarnings(checker, entry, checked) {
    if (entry.name === 'alert') {
        reportAlertWarnings(checker, entry, checked);
        return;
    }
    // precision and format on a plot set the formatting of the price scale the
    // plot maps to, so setting them over the price pane reformats the
    // instrument's own axis, which is almost never what was wanted.
    if (entry.name !== 'plot' || checker.declaration?.overlay !== true)
        return;
    const title = quoted(literalString(argumentFor(entry, checked, 'title')?.value) ?? '');
    for (const option of ['precision', 'format']) {
        if (argumentFor(entry, checked, option) === undefined)
            continue;
        checker.report('OS8007', checked.call.span, { title, option });
    }
}
/**
 * The name one watched condition is known by, `stdlib.md` 16.1.
 *
 * It is the `id` the script wrote, and where there is none to write down, one
 * derived from the line the call sits on. The derivation is here, once, because
 * the checker reports two alerts that would land under one name and the emitter
 * writes the name into `outputs.alerts[].key`, and two spellings of it would be
 * two different answers to "which subscription is this".
 *
 * An id is written down only when it is a literal. One taken from an `input()`
 * is a name that changes when a setting changes, and a subscription keyed on it
 * would stop matching the moment a user touched the dialog, so it is derived
 * like an absent one and OS8008 says so.
 */
export function alertKey(id, line) {
    return id === undefined || id === '' ? `alert@${line}` : id;
}
/** The `id` a call wrote down, or nothing where it wrote none it can keep. */
function writtenAlertId(entry, checked) {
    const written = literalString(argumentFor(entry, checked, 'id')?.value);
    return written === '' ? undefined : written;
}
/**
 * OS3017 over the watched conditions: two alerts that would share one name.
 *
 * A subscription is keyed by the name, so two entries under one name leave the
 * host with two conditions and one row: whichever it keeps, the other fires
 * nothing and nothing says which of the two the user subscribed to. The check
 * runs over the derived name as well as the written one, because an id somebody
 * writes by hand can collide with a derived one.
 */
export function reportRepeatedAlertIds(checker) {
    const seen = new Map();
    for (const checked of checker.calls) {
        if (checked.name !== 'alert' || checked.entry === undefined)
            continue;
        const line = checked.call.span.line;
        const key = alertKey(writtenAlertId(checked.entry, checked), line);
        const first = seen.get(key);
        if (first === undefined) {
            seen.set(key, line);
            continue;
        }
        checker.report('OS3017', checked.call.span, { kind: 'alert', name: `"${key}"`, line: first });
    }
}
function reportAlertWarnings(checker, entry, checked) {
    // With no id of its own the compiler derives one from the call's position,
    // which changes the moment a line is inserted above it and breaks a
    // subscription with it.
    if (writtenAlertId(entry, checked) === undefined) {
        checker.report('OS8008', checked.call.span, { line: checked.call.span.line });
    }
    // An alert on every execution of the bar can only fire in a file that acts on
    // a bar that is still moving (stdlib.md 16.2).
    const frequency = argumentFor(entry, checked, 'frequency');
    const written = literalString(frequency?.value);
    if (written !== 'everyUpdate' || checker.declaration?.onUnconfirmed === true)
        return;
    checker.report('OS3009', frequency?.span ?? checked.call.span, {
        option: 'frequency',
        value: written,
        required: 'onUnconfirmed = true',
    });
}
function argumentFor(entry, checked, name) {
    const index = entry.parameters.findIndex((one) => one.name === name);
    return index < 0 ? undefined : checked.arguments[index];
}
function quoted(text) {
    return `"${text}"`;
}
//# sourceMappingURL=outputs.js.map