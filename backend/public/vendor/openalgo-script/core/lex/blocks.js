/**
 * The block structure of language.md 3.10, which is a stack of indentation
 * widths and nothing more.
 *
 * Only a line that carries a token ever reaches this. A blank line and a
 * comment-only line carry no indentation at all: they never open a block, never
 * end one and are never OS1003, and the rule is kept by never asking about
 * them rather than by asking and forgiving.
 */
export class BlockStack {
    // The file's own top level, which no header opened. Line 1 is the honest
    // answer to where it began.
    #levels = [{ width: 0, openerLine: 1 }];
    get depth() {
        return this.#levels.length - 1;
    }
    #top() {
        return this.#levels[this.#levels.length - 1] ?? { width: 0, openerLine: 1 };
    }
    /**
     * Takes the next line's indentation.
     *
     * `afterHeader` is whether the statement above this line was one that opens a
     * block. Without it a line that drifted one space to the right would open a
     * block of its own and every sibling below it would be reported instead of
     * the one line that moved.
     */
    enter(width, afterHeader, openerLine) {
        const top = this.#top();
        if (width > top.width) {
            if (!afterHeader) {
                return { kind: 'mismatch', count: 0, expected: top.width, openerLine: top.openerLine };
            }
            this.#levels.push({ width, openerLine });
            return { kind: 'open' };
        }
        if (width === top.width)
            return { kind: 'same' };
        let count = 0;
        while (this.#levels.length > 1 && width < this.#top().width) {
            this.#levels.pop();
            count++;
        }
        const landed = this.#top();
        if (width === landed.width)
            return { kind: 'close', count };
        return { kind: 'mismatch', count, expected: landed.width, openerLine: landed.openerLine };
    }
    /** Every block still open, which the end of the file closes. */
    closeAll() {
        const count = this.#levels.length - 1;
        this.#levels.length = 1;
        return count;
    }
}
//# sourceMappingURL=blocks.js.map