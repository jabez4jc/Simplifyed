/**
 * What a fill costs, as an ordered list of lines the platform brings.
 *
 * **The language has three commission spellings and a slippage in ticks, and a
 * real cost stack is not shaped like that.** It is a flat fee, a percentage, a
 * charge levied on a charge, and a tax that applies to one side of the trade
 * only. Teaching the language one market's stack would be teaching it a market;
 * so the platform passes a schedule instead, and the language keeps the three
 * spellings it has, which turn into a schedule of one line.
 *
 * **Order is part of the result.** The lines are applied in the order they are
 * declared, a line charged on other lines may only name lines declared before
 * it, and that is what makes a schedule evaluable in exactly one order. Two
 * engines that disagree about the order disagree about the money, and a
 * disagreement in the last bit is still a failed conformance comparison
 * (`conformance.md` 6).
 *
 * **Where it is applied is not here.** `stdlib.md` 17.1 puts slippage and
 * commission on the destination: the engine folds the price it is told and
 * never adjusts one, so a cost model inside the ledger would be the engine
 * moving a price, which is the one thing the invariant forbids. This module
 * says what a charge is and works out what one fill came to; the destination is
 * what charges it, and the slippage a schedule carries is measured and applied
 * there, against the tick size this module only refuses the absence of.
 *
 * **What is charged to a fill, and only to a fill.** Every line is measured
 * against this fill and nothing else, so a tier that changes with the month's
 * cumulative volume, a cap counted per day rather than per application, and
 * margin and its interest are outside this model rather than approximated
 * inside it. A cost model that quietly approximates is a report that is wrong
 * in the strategy's favour and says nothing about it.
 */
import { diagnosticFor } from '../diagnostics/index.js';
/**
 * The most digits money is rounded to, and why there is a ceiling at all.
 *
 * A rounding scale is a power of ten and a binary64 holds about fifteen
 * significant decimal digits, so past this the scale itself is approximate and
 * the rounding stops being arithmetic and becomes noise. A currency with more
 * than fifteen decimal places is not a currency this module is refusing to
 * support; it is a digit count nobody stated on purpose.
 */
const MAX_DIGITS = 15;
/** A percentage, as the declaration states one, over the fraction a rate is. */
const PERCENT = 100;
/** What a refusal calls the setting it is about, `errors.md` OS6021. */
const SETTING = 'The charge schedule';
/**
 * Where a refusal about a setting points.
 *
 * Nowhere in the script, because a schedule is not something anybody wrote in
 * one: it is what the host stated before the first bar, and a caret drawn under
 * a line of the strategy would blame the one party who did not choose it. The
 * engine gives a load-time failure the same position for the same reason, and
 * the number is written here rather than imported from it because this module
 * imports no engine, which is what lets a stored record be reported again with
 * no engine present.
 */
const NO_POSITION = { offset: 0, length: 0, line: 0, column: 0 };
/**
 * What one fill cost, line by line and in total.
 *
 * **The lines are the arithmetic and the total is the money.** Each line's
 * amount is computed in binary64 and left unrounded, and the per-fill total is
 * rounded once, half to even, to the contract's digits. Rounding each line
 * would round once per line, and two engines rounding in two places disagree in
 * the last bit, which is a failed conformance comparison months later on
 * somebody else's engine. So a reader adding the lines up by hand may land a
 * fraction of the last digit away from the total, and that is the honest way
 * round: the total is the figure the report accumulates.
 *
 * **Half to even, and not the language's own rounding.** `round()` in the
 * language is halves away from zero, because a price a trader reads should
 * agree with what they would write down (`stdlib.md` 8.1). Money folded over
 * thousands of fills is a different question: away from zero biases every exact
 * half upward, and half a unit of the last digit per fill is a bias that grows
 * with the length of the backtest. Two rules, two reasons, both written down.
 *
 * **A line that does not apply to this side is not in the breakdown at all.** A
 * name beside a zero reads as a charge that was levied and came to nothing,
 * which is not what happened, and a later line levied on that name is levied on
 * nothing, which is exactly what a tax on one side of the trade does.
 */
export function chargeFor(schedule, fill, contract) {
    const turnover = fill.units * fill.price * contract.pointValue;
    const applied = [];
    for (const line of schedule.lines) {
        if (line.side !== 'both' && line.side !== fill.side)
            continue;
        const base = baseOf(line, turnover, fill.units, applied);
        applied.push({ name: line.name, amount: bounded(line.rate * base, line) });
    }
    let exact = 0;
    for (const one of applied)
        exact += one.amount;
    return { lines: applied, total: roundMoney(exact, contract.digits) };
}
/**
 * What a line's rate is measured against, for this fill.
 *
 * The earlier lines are searched rather than indexed. An index would be a map,
 * and this module has promised to depend on no map's iteration order; a
 * schedule is a handful of lines, so the search costs nothing and the promise
 * costs one less thing to be careful about.
 */
function baseOf(line, turnover, units, applied) {
    if (line.base === 'turnover')
        return turnover;
    if (line.base === 'units')
        return units;
    if (line.base === 'order')
        return 1;
    // 'charges': the sum of the named earlier lines, as they were charged on this
    // fill. A name whose line did not apply to this side is absent and adds
    // nothing, which is a charge levied on a charge that was never taken.
    let sum = 0;
    for (const named of line.of) {
        for (const one of applied) {
            if (one.name === named)
                sum += one.amount;
        }
    }
    return sum;
}
/**
 * The floor and the cap, per application.
 *
 * Both together is the common brokerage plan: a fraction of turnover, never
 * less than one amount and never more than another. Which is applied first does
 * not decide the answer, because a floor above a cap is refused before the
 * first bar rather than resolved here by whichever comparison runs first.
 */
function bounded(raw, line) {
    let amount = raw;
    if (line.min !== null && amount < line.min)
        amount = line.min;
    if (line.max !== null && amount > line.max)
        amount = line.max;
    return amount;
}
/**
 * One money figure, rounded once, halves to even.
 *
 * A digit count this cannot round by is one `scheduleProblem` refuses before
 * the first bar. If one arrives anyway the amount is returned as it stands,
 * because a scale of ten to the power of something impossible turns money into
 * a number JSON carries as null, and an unrounded figure is worth more.
 */
function roundMoney(amount, digits) {
    if (!Number.isFinite(amount))
        return amount;
    if (!Number.isInteger(digits) || digits < 0 || digits > MAX_DIGITS)
        return amount;
    const scale = 10 ** digits;
    const scaled = amount * scale;
    const below = Math.floor(scaled);
    const fraction = scaled - below;
    let whole = below;
    if (fraction > 0.5)
        whole = below + 1;
    else if (fraction === 0.5 && below % 2 !== 0)
        whole = below + 1;
    const money = whole / scale;
    // A negative zero is the same money as a zero and a different set of bytes.
    return money === 0 ? 0 : money;
}
/**
 * The declaration's own cost model, as the one schedule this module evaluates.
 *
 * **The declaration is not a second cost engine.** Its three commission
 * spellings are a schedule of one line: a flat fee is a line charged per fill,
 * a per unit fee is a line charged per unit, and a percentage is a line charged
 * on turnover. A second evaluator for the declaration would be the same money
 * computed two ways, and the day the two disagreed the report and the
 * platform's own cost panel would both be defensible.
 *
 * **A commission of zero is no line at all**, rather than a line charging
 * nothing. A zero line would put a name in every breakdown, and it would make a
 * declaration that states no commission indistinguishable from one that states
 * a commission, which is the distinction a run has to make before it accepts a
 * schedule from the host as well.
 *
 * **A flat fee is charged per fill**, which is the one place `language.md` 13.3
 * lets a reasonable person read the words two ways: per order, or per completed
 * round trip. A charge is attributed to the fill that incurred it everywhere in
 * this module, because that is what attributes it to a trade, so a round trip of
 * two fills is charged twice.
 *
 * The currency and the digit count are parameters because neither is the
 * declaration's to state: the declaration's currency is a label and is often
 * left blank, and money rounding is a fact about the contract. A default here
 * would be this module inventing a rounding rule for somebody else's market.
 *
 * `commissionType`'s value set is declared once, in `check/declaration.ts`, and
 * is not restated here: what is below is a mapping from each spelling to the
 * line it means. A program reaching this has been checked, so a fourth spelling
 * cannot arrive, and the spelling that falls through is the declaration's own
 * default rather than a shape this module made up.
 */
export function scheduleFromDeclaration(commission, commissionType, slippage, currency, digits) {
    return {
        currency,
        digits,
        slippageTicks: slippage,
        lines: commission === 0 ? [] : [commissionLine(commission, commissionType)],
        source: 'declaration',
    };
}
/** The one line a declared commission is, in the base its spelling names. */
function commissionLine(commission, commissionType) {
    if (commissionType === 'perUnit')
        return only('units', commission);
    if (commissionType === 'percent')
        return only('turnover', commission / PERCENT);
    return only('order', commission);
}
/** A line with no bounds, on both sides, levied on nothing: the declaration's shape. */
function only(base, rate) {
    return { name: 'commission', base, side: 'both', rate, min: null, max: null, of: [] };
}
/**
 * Why this schedule cannot be carried out, or null.
 *
 * **Asked before the first bar, and answered once.** Everything here is a fact
 * about the schedule rather than about any fill, so a run that would produce a
 * number nobody can explain is refused while nothing has been computed and the
 * cost of correcting it is one run. The contract is optional because a schedule
 * is checkable on its own: what it adds is the three questions that need both,
 * which are the currency the money is in, the digits it is rounded to, and the
 * tick a slippage in ticks is measured in.
 *
 * The first problem found is the one reported. A list of everything wrong with
 * a schedule reads as a worse schedule than it is, and it is corrected one line
 * at a time regardless.
 */
export function scheduleProblem(schedule, contract = null) {
    const problem = moneyProblem(schedule, contract) ??
        slippageProblem(schedule, contract) ??
        linesProblem(schedule.lines);
    if (problem === null)
        return null;
    return diagnosticFor('OS6021', NO_POSITION, { setting: SETTING, problem });
}
/**
 * The currency the money is in and the digits it is rounded to.
 *
 * A schedule states both and so does the contract, and the two are compared
 * here rather than one of them being quietly preferred. A schedule in another
 * currency charges a fill in money the contract is not priced in, and a total
 * nobody can add to the profit is worse than no total. A schedule rounding to
 * other digits is the same fact stated twice and left to disagree.
 */
function moneyProblem(schedule, contract) {
    const digits = schedule.digits;
    if (!Number.isInteger(digits) || digits < 0 || digits > MAX_DIGITS) {
        return `it rounds money to ${digits} digits, and a digit count is a whole number from 0 to ${MAX_DIGITS}`;
    }
    if (schedule.currency.trim() === '') {
        return 'it names no currency, so what it charges is a number with no unit on it';
    }
    if (contract === null)
        return null;
    if (schedule.currency !== contract.currency) {
        return `it charges in ${schedule.currency} and the contract is priced in ${contract.currency}`;
    }
    if (digits !== contract.digits) {
        return `it rounds money to ${digits} digits and the contract rounds to ${contract.digits}`;
    }
    return null;
}
/**
 * The slippage, which this module refuses and does not apply.
 *
 * A slippage in ticks with no tick size to measure a tick in would charge
 * nothing at all, and a backtest that silently charges nothing is one that lies
 * in the strategy's favour. It is refused here, where the schedule is checked,
 * rather than at the fill, where a zero looks like a cost model that ran.
 */
function slippageProblem(schedule, contract) {
    const ticks = schedule.slippageTicks;
    if (!Number.isFinite(ticks) || ticks < 0) {
        return `it states ${ticks} ticks of slippage, and slippage is adverse, so it is never negative`;
    }
    if (ticks === 0 || contract === null)
        return null;
    const tick = contract.tickSize;
    if (tick === null || !(tick > 0)) {
        return `it states ${ticks} ticks of slippage and the contract has no tick size to measure a tick in`;
    }
    return null;
}
/** Every line, in the order the schedule declares them, against the ones before it. */
function linesProblem(lines) {
    const declared = [];
    for (const line of lines) {
        const problem = lineProblem(line, declared);
        if (problem !== null)
            return problem;
        declared.push(line.name);
    }
    return null;
}
/** One line, against the names declared before it. */
function lineProblem(line, declared) {
    const name = line.name;
    if (name.trim() === '') {
        return 'a line carries no name, and a line levied on charges names the lines it is levied on';
    }
    if (declared.includes(name)) {
        return `two lines are named "${name}", so a line levied on that name is levied on two answers`;
    }
    if (!Number.isFinite(line.rate) || line.rate < 0) {
        return `the line "${name}" charges a rate of ${line.rate}, and a charge is money taken, never given`;
    }
    return boundProblem(line) ?? levyProblem(line, declared);
}
/** The floor and the cap: money, not negative, and the floor no higher than the cap. */
function boundProblem(line) {
    const { max, min, name } = line;
    if (min !== null && (!Number.isFinite(min) || min < 0)) {
        return `the line "${name}" has a floor of ${min}, and a bound on a charge is money`;
    }
    if (max !== null && (!Number.isFinite(max) || max < 0)) {
        return `the line "${name}" has a cap of ${max}, and a bound on a charge is money`;
    }
    if (min !== null && max !== null && min > max) {
        return `the line "${name}" has a floor of ${min} above its cap of ${max}`;
    }
    return null;
}
/**
 * What a line is levied on, which is the rule the whole ordering exists for.
 *
 * A line levied on lines not declared before it has no single evaluation order,
 * so two engines would charge two different amounts and both would be
 * defensible. Naming itself, naming a line declared after it and naming a line
 * that is not in the schedule at all are one problem in three spellings, and
 * they are reported as one: none of the three is declared before this line.
 */
function levyProblem(line, declared) {
    const name = line.name;
    if (line.base !== 'charges') {
        if (line.of.length === 0)
            return null;
        return `the line "${name}" names ${line.of.length} lines to be levied on and its base is ${line.base}, so the names are read by nothing`;
    }
    if (line.of.length === 0) {
        return `the line "${name}" is levied on charges and names none, so it is levied on nothing`;
    }
    const seen = [];
    for (const named of line.of) {
        if (!declared.includes(named)) {
            return `the line "${name}" is levied on "${named}", which is not declared before it`;
        }
        if (seen.includes(named)) {
            return `the line "${name}" is levied on "${named}" twice, so that line is charged on twice over`;
        }
        seen.push(named);
    }
    return null;
}
//# sourceMappingURL=charges.js.map