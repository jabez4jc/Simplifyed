export class GapLog {
    seen = new Set();
    gaps = [];
    /** Records a gap once per distinct sentence, however many lines provoke it. */
    add(gap) {
        const key = `${gap.specification}|${gap.what}`;
        if (this.seen.has(key))
            return;
        this.seen.add(key);
        this.gaps.push(gap);
    }
    get blocked() {
        return this.gaps.some((one) => one.blocking);
    }
}
//# sourceMappingURL=gaps.js.map