const WIDTH = 32;
/** Appending copies at most one short tail, never the contributed prefix. */
export class ContributionHistory {
    head;
    tail;
    count;
    constructor(head = null, tail = Object.freeze([]), count = 0) {
        this.head = head;
        this.tail = tail;
        this.count = count;
        Object.freeze(this);
    }
    append(value) {
        const full = this.tail.length === WIDTH;
        const head = full ? Object.freeze({ values: this.tail, prior: this.head }) : this.head;
        const tail = Object.freeze(full ? [value] : [...this.tail, value]);
        return new ContributionHistory(head, tail, this.count + 1);
    }
    /** Index chunk references once; each subsequent newest-first read is constant work. */
    view(length) {
        const size = Math.min(length, this.count);
        const chunks = [];
        let remaining = size - this.tail.length;
        let head = this.head;
        while (remaining > 0 && head !== null) {
            chunks.push(head.values);
            head = head.prior;
            remaining -= WIDTH;
        }
        return new ContributionView(this.tail, chunks, size);
    }
}
/** A transient index into the current window. It is not retained in state. */
export class ContributionView {
    tail;
    chunks;
    size;
    constructor(tail, chunks, size) {
        this.tail = tail;
        this.chunks = chunks;
        this.size = size;
    }
    at(back) {
        if (back < 0 || back >= this.size || !Number.isInteger(back))
            return null;
        if (back < this.tail.length)
            return this.tail[this.tail.length - 1 - back];
        const before = back - this.tail.length;
        return this.chunks[Math.floor(before / WIDTH)][WIDTH - 1 - before % WIDTH];
    }
}
//# sourceMappingURL=history.js.map