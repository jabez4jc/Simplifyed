import { NONE, fold, tailOf } from '../values/index.js';
import { smaStep, vwmaStep, wmaStep } from './simple.js';
import { emaStep, rmaStep } from './exponential.js';
import { hmaStep } from './shaped.js';
const TYPES = ['sma', 'ema', 'wma', 'rma', 'hma', 'vwma'];
/** Whether a string names one of the six averages `ma` accepts. */
export function isMaType(name) {
    return name !== null && TYPES.includes(name);
}
/**
 * `ma(src, len, type)`, with the warmup of whichever type was named.
 *
 * An unrecognised type is absence throughout, not a silent fall back to the
 * simple mean. A study that quietly drew a different average from the one its
 * settings say would be wrong in a way nobody could see.
 */
export function maStep(state, key, input, len, type) {
    if (type === null)
        return NONE;
    const mine = `${key}${type}`;
    if (type === 'vwma')
        return vwmaStep(state, mine, input, len);
    if (type === 'sma')
        return smaStep(state, mine, input.src, len);
    if (type === 'ema')
        return emaStep(state, mine, input.src, len);
    if (type === 'wma')
        return wmaStep(state, mine, input.src, len);
    if (type === 'rma')
        return rmaStep(state, mine, input.src, len);
    if (type === 'hma')
        return hmaStep(state, mine, input.src, len);
    return NONE;
}
/** `ma(src, len, type)` as a tail. */
export function maTail(len, type) {
    return tailOf((state, input) => maStep(state, 'q', input, len, type));
}
/** `ma(src, len, type)` over a whole series. */
export function ma(src, volume, len, type) {
    return fold(maTail(len, type), src.map((value, index) => ({ src: value, volume: volume[index] ?? NONE })));
}
//# sourceMappingURL=select.js.map