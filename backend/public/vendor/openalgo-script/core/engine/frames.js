import { ABSENT } from './values/index.js';
export function makeFrame(code, slots, cellBase, stateBase, series, positions) {
    return {
        code,
        pc: 0,
        slots: new Array(slots).fill(ABSENT),
        cellBase,
        stateBase,
        series,
        stack: [],
        positions,
    };
}
/**
 * The line and column of one instruction.
 *
 * A binary search rather than a scan, because a program with four thousand
 * instructions raising a diagnostic inside a loop would otherwise walk the
 * table once per raise, and a debugger stepping instruction by instruction asks
 * for this on every step.
 */
export function positionAt(positions, pc) {
    let low = 0;
    let high = positions.length - 1;
    let found;
    while (low <= high) {
        const middle = (low + high) >> 1;
        const entry = positions[middle];
        if (entry === undefined)
            break;
        if (entry[0] <= pc) {
            found = entry;
            low = middle + 1;
        }
        else {
            high = middle - 1;
        }
    }
    return found === undefined ? { line: 0, column: 0 } : { line: found[1], column: found[2] };
}
//# sourceMappingURL=frames.js.map