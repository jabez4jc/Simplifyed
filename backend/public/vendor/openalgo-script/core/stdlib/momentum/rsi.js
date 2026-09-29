import { NONE, fold, isPresent, result, tailOf } from '../values/index.js';
import { rmaStep } from '../averages/index.js';
import { changeStep } from '../series/index.js';
/** `rsi(src, len)`: from bar `len`. */
export function rsiStep(state, key, value, len) {
    const delta = changeStep(state, `${key}c`, value, 1);
    const up = isPresent(delta) ? result(Math.max(delta, 0)) : NONE;
    const down = isPresent(delta) ? result(Math.max(-delta, 0)) : NONE;
    const averageUp = rmaStep(state, `${key}u`, up, len);
    const averageDown = rmaStep(state, `${key}d`, down, len);
    if (!isPresent(averageUp) || !isPresent(averageDown))
        return NONE;
    // No down bar in the lookback is the top of the scale. This also catches a
    // lookback that never moved at all, where both averages are zero and the
    // ratio has no value; every reference implementation reads 100 there, and
    // disagreeing with all of them on a flat lookback would be a worse answer
    // than the one they give.
    if (averageDown === 0)
        return 100;
    return result(100 - 100 / (1 + averageUp / averageDown));
}
/** `rsi(src, len)` as a tail. */
export function rsiTail(len = 14) {
    return tailOf((state, value) => rsiStep(state, '', value, len));
}
/** `rsi(src, len)` over a whole series. */
export function rsi(src, len = 14) {
    return fold(rsiTail(len), src);
}
//# sourceMappingURL=rsi.js.map