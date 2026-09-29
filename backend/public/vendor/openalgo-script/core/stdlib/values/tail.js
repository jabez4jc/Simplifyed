import { newState } from './region.js';
/** A tail's step applied to a whole series, oldest bar first. */
export function fold(tail, inputs) {
    const out = [];
    for (const input of inputs)
        out.push(tail.next(input));
    return out;
}
/**
 * A tail from a step: a private region, advanced one bar per call.
 *
 * The region is the same shape an engine hands a stateful call, so the function
 * underneath does not know which of the two is driving it.
 */
export function tailOf(step) {
    const state = newState();
    return {
        next(input) {
            return step(state, input);
        },
    };
}
//# sourceMappingURL=tail.js.map