/**
 * The report: what a run came to, folded from its fills and its bar closes.
 *
 * **The evaluation order is fixed here and nowhere else**, because a report
 * that is right to eleven digits and different in the twelfth fails a
 * conformance comparison months later on somebody else's engine, and the cause
 * is always a line nobody thought was arithmetic. Fills in `seq` order, charge
 * lines in declaration order, one rounding per fill total, no collection
 * re-summed in another order, no dependence on a map's iteration order, no wall
 * clock and no random number generator anywhere in this module.
 *
 * **What the report is not is read by a script.** The money entries of the
 * `pos` namespace stay planned and go on refusing at the call. The moment a
 * script can read its own equity mid-run, the money layer joins the execution
 * path, and therefore joins the conformance surface, and every formula in this
 * module has to be agreed by a second engine before a script may branch on it.
 * This module computes the money after the fact from a record; whether a script
 * may read it is a later decision. That this module imports no engine is the
 * structural half of keeping that decision open: when it is taken, the engine
 * calls this, and there is no second implementation to disagree with.
 */
import { analysisOf } from './analysis.js';
import { chargeFor } from './charges.js';
import { equityOver } from './equity.js';
import { monthlyOver } from './monthly.js';
import { markersOf } from './markers.js';
import { summaryOf } from './statistics.js';
import { tradesOf } from './trades.js';
/**
 * The whole report, folded from the fills, the bar closes and the schedule.
 *
 * **One pass, in one order, and the order is the result.** The fills are put in
 * `seq` order once, here, and every fold below reads that same list: the
 * charges are computed in it, the trades are built from it, the curve is marked
 * along it and the markers come off it. A second ordering anywhere would be a
 * report that is right to eleven digits and different in the twelfth on
 * somebody else's engine, which is the failure this module is shaped to make
 * impossible rather than unlikely.
 *
 * **A charge belongs to the fill that incurred it.** `chargeFor` rounds one
 * fill's total once, and nothing here rounds it again or re-sums the collection
 * in another order, so `sum(trade.charges)` and `summary.charges` are the same
 * money and a test asserts it rather than a page claiming it.
 *
 * A run carried out under no schedule at all is charged nothing, which is a
 * study of the strategy before costs and is a thing worth being able to ask
 * for. It is not a default: `scheduleFromDeclaration` is what a run under the
 * declaration's own commission uses, and the caller states which it wants.
 */
export function reportOf(fills, marks, schedule, contract, capital) {
    const ordered = fills.slice().sort((a, b) => a.seq - b.seq);
    const charges = ordered.map((fill) => schedule === null ? 0 : chargeFor(schedule, fill, contract).total);
    const trades = tradesOf(ordered, charges, marks, contract);
    const equity = equityOver(trades, marks, contract, capital);
    const summary = summaryOf(trades, equity, contract, capital);
    return {
        summary,
        analysis: analysisOf(trades),
        trades,
        equity,
        monthly: monthlyOver(equity, trades),
        markers: markersOf(ordered, trades),
    };
}
//# sourceMappingURL=report.js.map