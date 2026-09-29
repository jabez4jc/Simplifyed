import { DOT, isDigit, isHexDigit, UNDERSCORE } from './characters.js';
/**
 * An underscore separates digit groups, so it only belongs to the literal when
 * a digit follows it. `1_` and `1__0` therefore end the literal at the first
 * underscore, and the caller reports what follows as a name that starts with a
 * digit, which is what they are.
 */
function runOfDigits(text, from, digit) {
    let i = from;
    for (;;) {
        const code = text.charCodeAt(i);
        if (digit(code)) {
            i++;
            continue;
        }
        if (code === UNDERSCORE && digit(text.charCodeAt(i + 1))) {
            i += 2;
            continue;
        }
        return i;
    }
}
/**
 * Reads the literal starting at `start`, which the caller has established
 * begins a number: a digit, or a dot with a digit after it.
 *
 * The value is computed here and carried on the token so that no later stage
 * re-reads the text and has to agree a second time about underscores and about
 * the hexadecimal form.
 */
export function scanNumber(text, start) {
    const second = text.charCodeAt(start + 1);
    const isHex = text.charCodeAt(start) === 0x30 &&
        (second === 0x78 || second === 0x58) &&
        isHexDigit(text.charCodeAt(start + 2));
    if (isHex) {
        const end = runOfDigits(text, start + 2, isHexDigit);
        return { end, value: Number(text.slice(start, end).replace(/_/g, '')) };
    }
    let i = runOfDigits(text, start, isDigit);
    // A dot only belongs to the literal when a digit follows it, so `x.y` reads as
    // an element access and `1.` reads as a number and a dot.
    if (text.charCodeAt(i) === DOT && isDigit(text.charCodeAt(i + 1))) {
        i = runOfDigits(text, i + 1, isDigit);
    }
    const exponent = text.charCodeAt(i);
    if (exponent === 0x65 || exponent === 0x45) {
        const sign = text.charCodeAt(i + 1);
        const digits = sign === 0x2b || sign === 0x2d ? i + 2 : i + 1;
        // Without a digit the `e` is not an exponent, and the caller reports the
        // letter sitting against a number rather than this reading a literal that
        // is not there.
        if (isDigit(text.charCodeAt(digits)))
            i = runOfDigits(text, digits, isDigit);
    }
    return { end: i, value: Number(text.slice(start, i).replace(/_/g, '')) };
}
//# sourceMappingURL=numbers.js.map