import { literalNumber } from './literals.js';
import { BAR_ZERO, allOf, delayed, earlier, weaken } from './warmup.js';
/**
 * The length an omitted argument contributes to a warmup, from its default.
 *
 * A warmup is a promise about exactly which bars are absent, and `atr()` is
 * `atr(14)` in the specification's own printed form, so a call that left its
 * length out has the same first bar as one that wrote it. Reading the default
 * here is what keeps the two the same. Without it an omitted length weakened
 * the warmup to a floor, and a floor in place of a number is the promise the
 * conformance suite tests quietly becoming a bound.
 */
function defaultLength(parameter) {
    if (parameter === undefined || parameter.type.kind !== 'number')
        return undefined;
    if (parameter.defaultText === undefined)
        return undefined;
    const value = Number(parameter.defaultText);
    return Number.isFinite(value) ? value : undefined;
}
/**
 * The first bar this call can produce a value for.
 *
 * Every rule but `total` and `argument` composes with the arguments' own
 * warmups, which is what makes `sma(ema(close, 10), 10)` absent until bar 18
 * rather than until bar 9. A length that is not written out as a number is a
 * length the checker does not have, so the answer becomes a floor.
 */
export function warmupOfCall(checker, entry, filled) {
    const argumentWarmup = (name) => {
        const index = entry.parameters.findIndex((one) => one.name === name);
        const argument = index < 0 ? undefined : filled[index];
        return argument === undefined ? undefined : checker.warmupOf(argument.value);
    };
    const supplied = filled.filter((one) => one !== undefined);
    const base = allOf(supplied.map((one) => checker.warmupOf(one.value)));
    const rule = entry.warmup;
    switch (rule.kind) {
        case 'total':
            return BAR_ZERO;
        case 'argument':
            return argumentWarmup(rule.param) ?? BAR_ZERO;
        case 'either': {
            const present = rule.params
                .map(argumentWarmup)
                .filter((one) => one !== undefined);
            return present.length === 0 ? BAR_ZERO : present.reduce(earlier);
        }
        case 'data':
            return weaken(base);
        case 'delay':
            return delayed(base, rule.bars);
        case 'params': {
            let total = 0;
            let known = rule.exact;
            for (const name of rule.params) {
                const index = entry.parameters.findIndex((one) => one.name === name);
                const argument = index < 0 ? undefined : filled[index];
                const value = argument === undefined
                    ? defaultLength(index < 0 ? undefined : entry.parameters[index])
                    : literalNumber(argument.value);
                if (value === undefined)
                    known = false;
                else
                    total += value;
            }
            // The lengths count towards the floor as much as towards the exact bar.
            // Dropping them when the answer is a floor was worth `add` bars and no
            // more, so a request built on one of these entries told a host to fetch
            // nothing backwards and the read answered from too few bars, which is a
            // number that looks right. A length is never negative, so the lengths
            // that are known are a floor on their own whatever the rest are.
            const bars = rule.scale * total + rule.add;
            return known ? delayed(base, bars) : weaken(delayed(base, bars));
        }
    }
}
/**
 * The first bar one output of a multi-output call can produce a value for.
 *
 * `stdlib.md` 2.3: the array itself is never absent and each element carries
 * its own warmup. An entry that states one length for the whole array is
 * stating the earliest of them, so reading an element through the array's
 * warmup promises a number for bars where that element is still absent, and a
 * read built on it fetches too little history. Where the specification states
 * the elements separately, the entry does too, and this is what picks one.
 */
export function warmupOfElement(checker, checked, index) {
    const entry = checked.entry;
    if (entry === undefined)
        return undefined;
    const rule = entry.elements[index];
    if (rule === undefined)
        return undefined;
    return warmupOfCall(checker, { ...entry, warmup: rule }, checked.arguments);
}
//# sourceMappingURL=call-warmup.js.map