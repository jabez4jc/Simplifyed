import { ContributionHistory, NONE, fold, slot, tailOf } from '../values/index.js';
/** `barsSince(cond)`: bars since the condition last held, 0 on the bar itself. */
export function barsSinceStep(state, key, cond) {
    let since = slot(state, key, -1);
    if (cond === true)
        since = 0;
    else if (since >= 0)
        since += 1;
    state[key] = since;
    return since < 0 ? NONE : since;
}
/** `barsSince(cond)` as a tail. */
export function barsSinceTail() {
    return tailOf((state, cond) => barsSinceStep(state, 's', cond));
}
/** `barsSince(cond)` over a whole series. */
export function barsSince(cond) {
    return fold(barsSinceTail(), cond);
}
/**
 * `valueWhen(cond, src, occurrence)`: `src` as it stood the last time the
 * condition held, or the one before that.
 *
 * A later occurrence can name any earlier true event. Immutable history keeps
 * those values, including absence, while checkpoints share the sealed prefix.
 */
export function valueWhenStep(state, key, input, occurrence) {
    if (!Number.isInteger(occurrence) || occurrence < 0)
        return NONE;
    const held = state[key];
    let hits = held instanceof ContributionHistory ? held : new ContributionHistory();
    if (input.cond === true) {
        hits = hits.append(input.src);
        state[key] = hits;
    }
    if (hits.count <= occurrence)
        return NONE;
    return hits.view(occurrence + 1).at(occurrence);
}
/** `valueWhen(cond, src, occurrence)` as a tail. */
export function valueWhenTail(occurrence = 0) {
    return tailOf((state, input) => valueWhenStep(state, 'v', input, occurrence));
}
/** `valueWhen(cond, src, occurrence)` over whole series. */
export function valueWhen(cond, src, occurrence = 0) {
    return fold(valueWhenTail(occurrence), cond.map((flag, index) => ({ cond: flag, src: src[index] ?? NONE })));
}
//# sourceMappingURL=conditions.js.map