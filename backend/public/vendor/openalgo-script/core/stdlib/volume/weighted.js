import { NONE, flag, fold, isPresent, result, slot, tailOf } from '../values/index.js';
/**
 * `vwapAnchor(src, resetWhen)`: from the first bar `resetWhen` is true.
 *
 * The bar the condition holds on is the first bar of the new average, not the
 * last bar of the old one. Absent before the condition has ever been true,
 * because there is no anchor to measure from and zero would read as a price.
 *
 * A price times volume that overflows is an absent term (`compiled-program.md`
 * section 3.1): the bar is absent and neither total moves, so the bar costs its
 * own reading and nothing after it. A total that overflows is kept as the
 * arithmetic produced it and is absent, so the average divided by it is absent
 * until the next anchor rather than the exact zero a finite flow over an
 * infinite volume would give.
 */
export function vwapAnchorStep(state, key, input) {
    const flowKey = `${key}f`;
    const tradedKey = `${key}v`;
    const anchoredKey = `${key}a`;
    if (input.reset) {
        state[flowKey] = 0;
        state[tradedKey] = 0;
        state[anchoredKey] = true;
    }
    if (!flag(state, anchoredKey))
        return NONE;
    if (!isPresent(input.src) || !isPresent(input.volume))
        return NONE;
    const term = result(input.src * input.volume);
    if (!isPresent(term))
        return NONE;
    const flow = slot(state, flowKey, 0) + term;
    const traded = slot(state, tradedKey, 0) + input.volume;
    state[flowKey] = flow;
    state[tradedKey] = traded;
    const numerator = result(flow);
    const divisor = result(traded);
    if (!isPresent(numerator) || !isPresent(divisor) || divisor === 0)
        return NONE;
    return result(numerator / divisor);
}
/** `vwapAnchor(src, resetWhen)` as a tail. */
export function vwapAnchorTail() {
    return tailOf((state, input) => vwapAnchorStep(state, '', input));
}
/** `vwapAnchor(src, resetWhen)` over whole series. */
export function vwapAnchor(src, volume, resetWhen) {
    return fold(vwapAnchorTail(), src.map((value, index) => ({
        src: value,
        volume: volume[index] ?? NONE,
        reset: resetWhen[index] === true,
    })));
}
/**
 * `vwap(src)`: the same average anchored to the session, from the session's
 * first bar.
 *
 * `sessionStart` is the engine's answer to "does a new trading session begin on
 * this bar", read off the instrument's stated trading hours, which is why it
 * is an argument rather than something derived from the timestamps here. On a daily or longer interval every bar is its own
 * session, so every bar is an anchor and the result equals `src`; the compiler
 * emits warning OS8006 saying so, which is a compile-time matter and not this
 * library's.
 */
export function vwapTail() {
    return vwapAnchorTail();
}
/** `vwap(src)` as a step, which is `vwapAnchor` anchored to the session. */
export function vwapStep(state, key, input) {
    return vwapAnchorStep(state, key, input);
}
/** `vwap(src)` over whole series. */
export function vwap(src, volume, sessionStart) {
    return vwapAnchor(src, volume, sessionStart);
}
//# sourceMappingURL=weighted.js.map