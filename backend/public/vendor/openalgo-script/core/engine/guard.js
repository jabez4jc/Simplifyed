import { raise } from './errors.js';
export function guardFor(budget) {
    return {
        array(span, name, size) {
            budget.checkArray(span, name, size);
        },
        string(span, text) {
            return budget.checkString(span, text);
        },
        chars(span, length) {
            budget.checkLength(span, length);
        },
        drawing(span, held) {
            budget.checkDrawing(span, held);
        },
        /**
         * An argument outside its contract, OS4003.
         *
         * The compile-time half of this is OS3004, which the checker raises when
         * the argument is a literal. This is the run-time half, for a length a
         * script computed, and it names the call and the parameter so the reader is
         * looking at one argument rather than at a line.
         */
        badArgument(span, name, argument, found) {
            raise('OS4003', span, { name, argument, found });
        },
        badIndex(span, name, index, size) {
            raise('OS4004', span, { index, name, size });
        },
        /**
         * A cell outside the grid its table declared, OS4008.
         *
         * Not OS4004, which is about an array and would name an index and a
         * flattened element count: a table's shape is two numbers the declaration
         * fixed, and the fix is to declare the shape the script writes.
         */
        badCell(span, row, column, rows, columns) {
            raise('OS4008', span, { row, column, rows, columns });
        },
        deleted(span, kind, bar) {
            raise('OS4005', span, { kind, bar });
        },
        /**
         * A timezone name the host's table does not hold, OS6005.
         *
         * Not absence, because an absent answer here would be indistinguishable
         * from a host that stated no timezone at all, and not an invented offset,
         * because an offset is silently wrong for half the year anywhere that
         * observes a seasonal clock change.
         */
        badZone(span, value) {
            raise('OS6005', span, { value });
        },
    };
}
//# sourceMappingURL=guard.js.map