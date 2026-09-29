import { ASTERISK, LINE_FEED, SLASH } from './characters.js';
/**
 * The block comment markers of other languages, which this one does not have
 * (3.2).
 *
 * They are recognised here so that the region a writer meant as a comment can
 * be skipped and reported once, at the marker that opened it. Read as tokens
 * instead, the opener is a divide against a multiply and the prose between the
 * markers is a statement, so a reader is handed several diagnostics that are
 * each true of a program they never wrote and none of which mentions the
 * comment. That is OS1026's whole reason for existing.
 */
/** Whether the two characters at `at` open a region: a slash then a star. */
export function opensComment(text, at) {
    return text.charCodeAt(at) === SLASH && text.charCodeAt(at + 1) === ASTERISK;
}
/**
 * Whether the two characters at `at` close one: a star then a slash.
 *
 * A star written against the line comment form is a multiply and a comment,
 * never a closer, because the comment form the language does have wins.
 * Without that, a legal line whose multiply touches the comment after it would
 * be read as a marker and reported, and a diagnostic on a correct program is
 * the one mistake a lexer may never make.
 */
export function closesComment(text, at) {
    return (text.charCodeAt(at) === ASTERISK &&
        text.charCodeAt(at + 1) === SLASH &&
        text.charCodeAt(at + 2) !== SLASH);
}
/**
 * Reads from `from` to the closer, stopping at the end of the line.
 *
 * The scan is per line because the lexer works in lines, and because a region
 * that stays open has to be the caller's decision rather than this one's: a
 * closer on the line it opened on costs the reader nothing else, and a missing
 * one costs them the lines below.
 */
export function commentRegion(text, from) {
    for (let i = from; i < text.length; i++) {
        if (text.charCodeAt(i) === LINE_FEED)
            return { end: i, open: true };
        if (closesComment(text, i))
            return { end: i + 2, open: false };
    }
    return { end: text.length, open: true };
}
/**
 * Whether a closer is written anywhere from `from` on.
 *
 * An opener whose closer was never written is not a region at all: it costs the
 * reader the line it sits on and nothing below it. Reading the rest of the file
 * as a comment would be the silent swallow that language.md 3.2 gives as the
 * reason the form does not exist, and one marker may not cost a reader every
 * other mistake in their file.
 */
export function hasCloser(text, from) {
    for (let i = from; i < text.length; i++) {
        if (closesComment(text, i))
            return true;
    }
    return false;
}
//# sourceMappingURL=comments.js.map