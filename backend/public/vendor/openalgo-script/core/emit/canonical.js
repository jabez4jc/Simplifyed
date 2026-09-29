import { sha256 } from './sha256.js';
/**
 * A number as text: the one writer.
 *
 * Two engines compare numbers as bits, but they compare text in a case file, an
 * expected column, a table cell and `text(x)`, so how a number becomes text has
 * to be one rule that both implement, and in this repository it has to be one
 * function. This is that function. `scripts/check-number-writer.mjs` reads
 * every file under `src` and refuses a conversion outside this module, so a
 * number cannot reach text by a host's default somewhere else and disagree with
 * this one by a plus sign.
 *
 * **The digits are the host's and the layout is not.** The shortest decimal
 * digit string that reads back as the same binary64 is what every host this
 * engine runs on produces, and what a second engine's host produces too; that
 * part is taken from the host's own shortest form. Where the two hosts part
 * company is the layout, when a value is written positionally and when with an
 * exponent, and how the exponent is spelled, so that half is written here from
 * the rule in `language.md` 5.5 and not left to the host. The rule is the one
 * the first host follows natively, minus the `+` it writes on a positive
 * exponent, and `spec/vectors/number-text.json` holds the boundary cases a
 * second engine checks itself against.
 */
export function canonicalNumber(value) {
    if (!Number.isFinite(value))
        throw new Error('a compiled program holds finite numbers only');
    // Zero and negative zero are one value to the language (compiled-program.md
    // 3.1) and one spelling here.
    if (value === 0)
        return '0';
    const { digits, point } = shortestDigits(Math.abs(value));
    return (value < 0 ? '-' : '') + layout(digits, point);
}
/**
 * The shortest round trip digits of a positive finite magnitude, and where the
 * decimal point falls: the value is `0.d1d2...dk` times ten to the `point`.
 *
 * Read out of the host's own shortest form rather than computed here, because
 * the search for the shortest digit string is the one part of the conversion
 * every host already agrees on. Whatever layout the host chose is undone: the
 * digits and the point are all that is kept.
 */
function shortestDigits(magnitude) {
    const shown = String(magnitude);
    const e = shown.indexOf('e');
    const mantissa = e < 0 ? shown : shown.slice(0, e);
    const exponent = e < 0 ? 0 : Number(shown.slice(e + 1));
    const dot = mantissa.indexOf('.');
    const whole = dot < 0 ? mantissa : mantissa.slice(0, dot);
    const fraction = dot < 0 ? '' : mantissa.slice(dot + 1);
    let digits = whole + fraction;
    let point = whole.length + exponent;
    // A positional form below one carries leading zeros that are not digits of
    // the value, and a whole number carries trailing zeros that are its layout.
    while (digits.startsWith('0')) {
        digits = digits.slice(1);
        point -= 1;
    }
    while (digits.endsWith('0'))
        digits = digits.slice(0, -1);
    return { digits, point };
}
/** `language.md` 5.5: positional between the two thresholds, an exponent outside them. */
function layout(digits, point) {
    const count = digits.length;
    if (count <= point && point <= 21)
        return digits + '0'.repeat(point - count);
    if (0 < point && point <= 21)
        return `${digits.slice(0, point)}.${digits.slice(point)}`;
    if (-6 < point && point <= 0)
        return `0.${'0'.repeat(-point)}${digits}`;
    const exponent = point - 1;
    const lead = count === 1 ? digits : `${digits[0]}.${digits.slice(1)}`;
    return `${lead}e${exponent < 0 ? '-' : ''}${String(Math.abs(exponent))}`;
}
export function canonicalString(value) {
    let out = '"';
    for (const character of value) {
        const code = character.codePointAt(0) ?? 0;
        if (character === '"')
            out += '\\"';
        else if (character === '\\')
            out += '\\\\';
        else if (character === '\n')
            out += '\\n';
        else if (character === '\r')
            out += '\\r';
        else if (character === '\t')
            out += '\\t';
        else if (code < 0x20)
            out += `\\u${code.toString(16).padStart(4, '0')}`;
        else
            out += character;
    }
    return `${out}"`;
}
export function canonicalise(value) {
    if (value === null || value === undefined)
        return 'null';
    if (typeof value === 'boolean')
        return value ? 'true' : 'false';
    if (typeof value === 'number')
        return canonicalNumber(value);
    if (typeof value === 'string')
        return canonicalString(value);
    if (Array.isArray(value))
        return `[${value.map(canonicalise).join(',')}]`;
    if (typeof value === 'object') {
        const entries = Object.entries(value).filter(([, one]) => one !== undefined);
        entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        const body = entries
            .map(([key, one]) => `${canonicalString(key)}:${canonicalise(one)}`)
            .join(',');
        return `{${body}}`;
    }
    throw new Error(`a compiled program holds no value of this kind: ${typeof value}`);
}
/**
 * The two hashes a host records against a run.
 *
 * `source.hash` identifies the source and the hash of the canonical encoding
 * identifies the program, and they are two answers because a compiler change
 * that alters what a source compiles to has to be visible without the source
 * having changed at all.
 */
export function sourceHash(text) {
    return `sha256:${sha256(text)}`;
}
export function programHash(program) {
    return `sha256:${sha256(canonicalise(program))}`;
}
//# sourceMappingURL=canonical.js.map