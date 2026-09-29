import { entry } from './binding.js';
export { copyState } from '../../stdlib/index.js';
/** An entry for a call that keeps a region between bars. */
export function stateful(name, params, call) {
    return entry(name, params, call, { state: true });
}
/**
 * What a true range needs, taken from the bar the machine is executing.
 *
 * The previous close comes from the bar rather than from the region on purpose:
 * it is a fact about the dataset, the same for every call on the bar, and a
 * call inside a branch does not see every bar, so the close of the bar that
 * call last ran on would be a different number.
 */
export function gapAt(ctx) {
    const { high, low, previousClose, index } = ctx.bar;
    return { high, low, previousClose, isFirstBar: index === 0 };
}
//# sourceMappingURL=state.js.map