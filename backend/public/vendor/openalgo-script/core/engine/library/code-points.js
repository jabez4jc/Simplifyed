/**
 * The two string rules two engines have to share, written from the page.
 *
 * **A string is a sequence of code points** (`compiled-program.md` 3.1), and the
 * host this engine is written in stores one as sixteen bit units. Every rule
 * here counts code points and not units, because the two disagree the moment a
 * string holds a symbol outside the basic plane, and a rule written on the
 * host's units would be a rule a second engine could not follow.
 *
 * **Ordering.** Two strings are ordered by comparing code points from the
 * front, the first difference deciding, and a string that runs out first
 * ordering first (`language.md` 9.3, `stdlib.md` section 10). The host's own
 * `<` orders by unit, which puts every symbol outside the basic plane, stored
 * as a surrogate pair from U+D800, below the code points from U+E000 to U+FFFF
 * that come after it, so it is not used.
 *
 * **Whitespace.** `str.trim` removes, and `toNumber` ignores, exactly the code
 * points `stdlib.md` section 10 lists, which are the ones with the Unicode
 * White_Space property. The host's own `trim` removes a set that is nearly this
 * one: it takes the byte order mark U+FEFF as well, and a second engine's host
 * takes the four separators U+001C to U+001F and leaves the byte order mark, so
 * neither host's default is the set, and the set is implemented from the list.
 * `tests/engine/strings.test.ts` walks every code point of the basic plane
 * against the list read out of the page.
 */
/** The code points `str.trim` removes, as `stdlib.md` section 10 lists them. */
const WHITESPACE = new Set([
    0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x0085, 0x00a0, 0x1680,
    0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
    0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);
/** Code points, which is what every index over a string counts. */
export function points(text) {
    return [...text];
}
/** Whether one code point is in the trimmed set. */
export function isWhitespace(point) {
    return WHITESPACE.has(point);
}
/** `text` with the whitespace of the written set taken off both ends. */
export function trimmed(text) {
    const all = points(text);
    let from = 0;
    let to = all.length;
    while (from < to && isWhitespace(all[from]?.codePointAt(0) ?? -1))
        from += 1;
    while (to > from && isWhitespace(all[to - 1]?.codePointAt(0) ?? -1))
        to -= 1;
    return from === 0 && to === all.length ? text : all.slice(from, to).join('');
}
/**
 * The order of two strings, negative when `a` comes first, by code point.
 *
 * Walked with the string iterator so a surrogate pair is one code point, and
 * compared as numbers so U+10000 comes after U+FFFF, which is the order the
 * page states and the one an engine with four byte strings gets for free.
 */
export function compareStrings(a, b) {
    const left = a[Symbol.iterator]();
    const right = b[Symbol.iterator]();
    for (;;) {
        const one = left.next();
        const other = right.next();
        if (one.done)
            return other.done ? 0 : -1;
        if (other.done)
            return 1;
        const x = one.value.codePointAt(0) ?? 0;
        const y = other.value.codePointAt(0) ?? 0;
        if (x !== y)
            return x < y ? -1 : 1;
    }
}
//# sourceMappingURL=code-points.js.map