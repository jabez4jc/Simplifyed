import { BACKSLASH, isHexDigit, LINE_FEED } from './characters.js';
/** The escapes of language.md 3.6, apart from \uXXXX which carries its own digits. */
const SIMPLE = new Map([
    [0x5c, '\\'],
    [0x22, '"'],
    [0x27, "'"],
    [0x6e, '\n'],
    [0x74, '\t'],
    [0x72, '\r'],
    [0x30, '\u0000'],
]);
const UNICODE_ESCAPE = 0x75;
/** How many hexadecimal digits follow, up to the four a \uXXXX escape needs. */
function hexDigitsAfter(text, from) {
    let count = 0;
    while (count < 4 && isHexDigit(text.charCodeAt(from + count)))
        count++;
    return count;
}
/**
 * Reads the literal opening at `start`, which is the quote character, in either
 * delimiter of language.md 3.6.
 *
 * A literal may not span a line, so the scan stops at the newline and says so
 * rather than swallowing the rest of the file. The caller reports OS1004 at the
 * opening quote, which is where the mistake is, and keeps the text that was
 * read so that the statement around it still parses and the reader is not shown
 * a second error for the same missing character.
 */
export function scanString(text, start) {
    const quote = text.charCodeAt(start);
    const badEscapes = [];
    let value = '';
    let plainFrom = start + 1;
    let i = start + 1;
    const takePlain = (upTo) => {
        if (upTo > plainFrom)
            value += text.slice(plainFrom, upTo);
    };
    while (i < text.length) {
        const code = text.charCodeAt(i);
        if (code === LINE_FEED)
            break;
        if (code === quote) {
            takePlain(i);
            return { end: i + 1, value, unterminated: false, badEscapes };
        }
        if (code !== BACKSLASH) {
            i++;
            continue;
        }
        const next = text.charCodeAt(i + 1);
        // A backslash at the end of the line escapes nothing, because the line is
        // where the literal has to end. That is one missing quote, not two errors.
        if (Number.isNaN(next) || next === LINE_FEED)
            break;
        takePlain(i);
        const simple = SIMPLE.get(next);
        if (simple !== undefined) {
            value += simple;
            i += 2;
            plainFrom = i;
            continue;
        }
        if (next === UNICODE_ESCAPE) {
            const digits = hexDigitsAfter(text, i + 2);
            if (digits === 4) {
                value += String.fromCharCode(Number.parseInt(text.slice(i + 2, i + 6), 16));
                i += 6;
                plainFrom = i;
                continue;
            }
            const length = 2 + digits;
            badEscapes.push({ offset: i, length, text: text.slice(i, i + length) });
            value += text.slice(i + 1, i + length);
            i += length;
            plainFrom = i;
            continue;
        }
        // The written character, whole: an astral character is two code units, and
        // reporting half of one puts a broken surrogate in the message.
        const written = String.fromCodePoint(text.codePointAt(i + 1) ?? next);
        const length = 1 + written.length;
        badEscapes.push({ offset: i, length, text: text.slice(i, i + length) });
        value += written;
        i += length;
        plainFrom = i;
    }
    takePlain(i);
    return { end: i, value, unterminated: true, badEscapes };
}
//# sourceMappingURL=strings.js.map