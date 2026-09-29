/**
 * OS1001: naming the character that was found, and the plain spelling to write
 * instead.
 *
 * The replacement sentences are the substitution table of errors.md section 7,
 * which is the one part of an OS1001 message that errors.json does not carry:
 * the catalogue holds the message and the fix, and section 7 holds the third
 * column that fills {suggestion}. The table is transcribed here rather than
 * paraphrased, and the moment it moves into errors.json this file is generated
 * away instead of being edited.
 *
 * A character the table does not name takes the generic sentence, which is what
 * section 7 says to do with one.
 */
const PLAIN_SPACE = 'Use a plain space instead.';
const STRAIGHT_QUOTE = 'Use a straight quote instead.';
const ASCII_NAME = 'Use the ASCII spelling of the name instead.';
const INDENTATION = 'Use indentation instead, which is how a block is written.';
const PUT_IN_A_STRING = 'Delete it, or put the text in a string.';
const GENERIC = 'Delete it, or move it inside a string literal.';
/** The rows of section 7 that name an exact spelling. */
const SPELLINGS = new Map([
    ['!', 'Write not instead.'],
    ['&&', 'Write and instead.'],
    ['||', 'Write or instead.'],
    ['^', 'Write pow(a, b) instead.'],
    ['**', 'Write pow(a, b) instead.'],
    ['++', 'Write a += 1 instead.'],
    ['{', INDENTATION],
    ['}', INDENTATION],
    ['#', PUT_IN_A_STRING],
    ['$', PUT_IN_A_STRING],
    ['@', PUT_IN_A_STRING],
]);
/**
 * Names for the characters a reader cannot see on their screen.
 *
 * A message that quotes an invisible character quotes nothing, and the whole
 * point of OS1001 is that an invisible character produces a baffling error
 * three tokens later. The name and the code point are what makes the message
 * act on: a reader can search their file for the one and read the other aloud.
 */
const NAMES = new Map([
    [0x0009, 'a tab'],
    [0x000d, 'a carriage return'],
    [0x00a0, 'a no-break space'],
    [0x2002, 'an en space'],
    [0x2003, 'an em space'],
    [0x2007, 'a figure space'],
    [0x2009, 'a thin space'],
    [0x200a, 'a hair space'],
    [0x202f, 'a narrow no-break space'],
    [0x3000, 'an ideographic space'],
    [0x200b, 'a zero width space'],
    [0x200c, 'a zero width non-joiner'],
    [0x200d, 'a zero width joiner'],
    [0xfeff, 'a byte order mark'],
    [0x2018, 'a left single quotation mark'],
    [0x2019, 'a right single quotation mark'],
    [0x201c, 'a left double quotation mark'],
    [0x201d, 'a right double quotation mark'],
    [0x2013, 'an en dash'],
    [0x2014, 'an em dash'],
    [0x2026, 'a horizontal ellipsis'],
]);
const TYPOGRAPHIC_QUOTES = '\u2018\u2019\u201c\u201d\u201a\u201b\u201e\u201f';
const SPACE_SEPARATOR = /\p{Zs}/u;
const LETTER = /\p{L}/u;
const ASCII_GRAPHIC = /^[\x21-\x7e]+$/;
function codePointLabel(text) {
    const point = text.codePointAt(0) ?? 0;
    return `U+${point.toString(16).toUpperCase().padStart(4, '0')}`;
}
/**
 * The {char} slot. An ASCII graphic speaks for itself; everything else is
 * quoted and then identified, because the quotes may well hold nothing a reader
 * can see.
 */
function describe(written) {
    if (ASCII_GRAPHIC.test(written))
        return `"${written}"`;
    const name = NAMES.get(written.codePointAt(0) ?? -1);
    const label = codePointLabel(written);
    return name === undefined ? `"${written}" (${label})` : `"${written}" (${name}, ${label})`;
}
function suggestionFor(written) {
    const spelling = SPELLINGS.get(written);
    if (spelling !== undefined)
        return spelling;
    // A tab is a space that happens to be a control character, and the table's
    // answer to every other invisible space is the same plain space.
    if (written === '\t' || SPACE_SEPARATOR.test(written))
        return PLAIN_SPACE;
    if (TYPOGRAPHIC_QUOTES.includes(written))
        return STRAIGHT_QUOTE;
    if (LETTER.test(written))
        return ASCII_NAME;
    return GENERIC;
}
/** What OS1001 says about one rejected character, or one rejected operator. */
export function describeUnexpected(written) {
    return { char: describe(written), suggestion: suggestionFor(written) };
}
/**
 * Whether a code point is a letter the language does not allow in a name.
 *
 * It is asked once per word, at the character that ended the word, so that
 * `l\u00e4ngd` is one name with one error on the one character 3.3 refuses,
 * rather than two names with a stray character between them.
 */
export function isNonAsciiLetter(point) {
    return point > 0x7f && LETTER.test(String.fromCodePoint(point));
}
//# sourceMappingURL=unexpected.js.map