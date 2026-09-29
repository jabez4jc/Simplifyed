import { diagnosticFor, isError } from './diagnostic.js';
/**
 * Two codes in code point order, which is the same order everywhere.
 *
 * `<` on two strings compares UTF-16 code units and reads no environment
 * setting, which is exactly what `language.md` 9.3 fixes for the language's own
 * string comparison. The engine's own output obeys the rule it gives scripts.
 */
function byCodePoint(left, right) {
    if (left < right)
        return -1;
    return left > right ? 1 : 0;
}
/**
 * Gathers diagnostics instead of throwing on the first one.
 *
 * A trader who has three syntax errors in a file wants to see three, not one
 * per compile. A compiler that throws makes the second error cost a whole
 * edit-and-run cycle to discover, and it is the same file, so the cost is paid
 * for nothing.
 *
 * The bag refuses an exact repeat: the same code over the same span, which is
 * what a parser that recovers and re-enters the same construct produces. It
 * refuses nothing else, so two different codes on one character both survive
 * and the reader decides which one they believe.
 */
export class DiagnosticBag {
    #items = [];
    #seen = new Set();
    report(code, span, values) {
        this.add(diagnosticFor(code, span, values));
    }
    add(diagnostic) {
        const key = `${diagnostic.code}:${diagnostic.span.offset}:${diagnostic.span.length}`;
        if (this.#seen.has(key))
            return;
        this.#seen.add(key);
        this.#items.push(diagnostic);
    }
    /** Everything reported, in the order it was reported. */
    get all() {
        return this.#items;
    }
    get isEmpty() {
        return this.#items.length === 0;
    }
    /** Whether compilation has to stop. A file with only warnings still runs. */
    get hasErrors() {
        return this.#items.some(isError);
    }
    get errors() {
        return this.#items.filter(isError);
    }
    get warnings() {
        return this.#items.filter((item) => !isError(item));
    }
    /**
     * Everything reported, in the order a reader walks the file.
     *
     * Stages report in the order they run, so a checker warning about line 2
     * arrives after a parser error about line 40. A reader reads top to bottom.
     *
     * **The order is total, and it depends on nothing outside the program.** Two
     * engines handed the same diagnostics have to print them in the same order, so
     * the tie after the offset is the span's length and then the code compared by
     * code point. It was a locale comparison, which `compiled-program.md` 8.4
     * forbids by name: the same two codes order differently under different
     * collation rules, and the machine that is set up differently is the one
     * nobody is looking at. Length is in the comparison because without it two
     * diagnostics sharing a code and an offset tie, and a tie leaves the answer to
     * whether the sort happens to be stable, which is a property of the engine
     * rather than of the language. With it, nothing can tie: the bag already
     * refuses a second diagnostic with the same code, offset and length.
     */
    ordered() {
        return [...this.#items].sort((left, right) => left.span.offset - right.span.offset ||
            left.span.length - right.span.length ||
            byCodePoint(left.code, right.code));
    }
}
//# sourceMappingURL=collector.js.map