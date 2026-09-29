import { NONE, fold, isPresent, result, tailOf } from '../values/index.js';
import { emaStep } from '../averages/index.js';
/**
 * `macd(src, fast, slow, signal)`: `[macd, signal, histogram]`, element 0 from
 * bar `slow - 1` and the other two from bar `slow + signal - 2`.
 */
export function macdStep(state, key, value, fast, slow, signal) {
    const near = emaStep(state, `${key}e`, value, fast);
    const far = emaStep(state, `${key}g`, value, slow);
    const line = isPresent(near) && isPresent(far) ? result(near - far) : NONE;
    const trigger = emaStep(state, `${key}i`, line, signal);
    const histogram = isPresent(line) && isPresent(trigger) ? result(line - trigger) : NONE;
    return [line, trigger, histogram];
}
/** `macd(src, fast, slow, signal)` as a tail. */
export function macdTail(fast = 12, slow = 26, signal = 9) {
    return tailOf((state, value) => macdStep(state, '', value, fast, slow, signal));
}
/** `macd(src, fast, slow, signal)` over a whole series. */
export function macd(src, fast = 12, slow = 26, signal = 9) {
    return fold(macdTail(fast, slow, signal), src);
}
/**
 * `ppo(src, fast, slow, signal)`: `[ppo, signal, histogram]`, on the same
 * warmups as `macd`.
 *
 * The same gap divided by the slow average, so the reading is a percentage and
 * two instruments at different price levels can be compared.
 */
export function ppoStep(state, key, value, fast, slow, signal) {
    const near = emaStep(state, `${key}e`, value, fast);
    const far = emaStep(state, `${key}g`, value, slow);
    const line = isPresent(near) && isPresent(far) && far !== 0
        ? result((100 * (near - far)) / far)
        : NONE;
    const trigger = emaStep(state, `${key}i`, line, signal);
    const histogram = isPresent(line) && isPresent(trigger) ? result(line - trigger) : NONE;
    return [line, trigger, histogram];
}
/** `ppo(src, fast, slow, signal)` as a tail. */
export function ppoTail(fast = 12, slow = 26, signal = 9) {
    return tailOf((state, value) => ppoStep(state, '', value, fast, slow, signal));
}
/** `ppo(src, fast, slow, signal)` over a whole series. */
export function ppo(src, fast = 12, slow = 26, signal = 9) {
    return fold(ppoTail(fast, slow, signal), src);
}
//# sourceMappingURL=convergence.js.map