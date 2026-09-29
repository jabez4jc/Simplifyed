/**
 * What a character is, in the alphabet language.md 3.1 allows outside a string
 * literal: ASCII letters, ASCII digits, space, newline and the punctuation of
 * 3.12. Anything else is OS1001, so a classifier that answered questions about
 * a wider alphabet would be answering a question the language never asks.
 *
 * Every predicate takes a code unit rather than a string. The scanner asks
 * about each character of the file in turn, and a one character string per
 * question is an allocation per character of every compile.
 */
export const LINE_FEED = 0x0a;
export const SPACE = 0x20;
export const TAB = 0x09;
export const QUOTE = 0x22;
export const APOSTROPHE = 0x27;
export const HASH = 0x23;
export const DOT = 0x2e;
export const SLASH = 0x2f;
export const ASTERISK = 0x2a;
export const BACKSLASH = 0x5c;
export const SEMICOLON = 0x3b;
export const UNDERSCORE = 0x5f;
export function isDigit(code) {
    return code >= 0x30 && code <= 0x39;
}
export function isHexDigit(code) {
    return isDigit(code) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
}
export function isAsciiLetter(code) {
    return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}
/** An identifier begins with an ASCII letter or an underscore (3.3). */
export function isNameStart(code) {
    return isAsciiLetter(code) || code === UNDERSCORE;
}
export function isNamePart(code) {
    return isNameStart(code) || isDigit(code);
}
/**
 * Horizontal whitespace.
 *
 * A tab is included although the language accepts none: it is recognised here
 * so that it can be reported where it sits, as OS1002 in leading whitespace and
 * as OS1001 anywhere else, rather than ending a token and confusing the next
 * one.
 */
export function isBlank(code) {
    return code === SPACE || code === TAB;
}
//# sourceMappingURL=characters.js.map