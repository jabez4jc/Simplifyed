/**
 * The money: what a run made, what it cost, and what that is worth knowing.
 *
 * **This module imports no engine and no emitter, and it never will.** It is
 * arithmetic over portable data: a list of settled fills, a list of bar closes,
 * a charge schedule and the contract the run was carried out under. Two things
 * follow from that and both of them are the reason for it.
 *
 * A stored record can be reported again with no engine present, which is what
 * makes a run record a conformance case rather than a souvenir. And the engine
 * can call this, when the day comes that a script may read its own equity,
 * without a cycle and without a second implementation of any of these formulas
 * sitting inside the execution path disagreeing with this one.
 *
 * The door names what a caller may use. The fold itself, the cost basis, the
 * round trip state machine and the statistics stay behind it: they are one
 * algorithm with one caller.
 *
 * Behaviour lands beside these shapes, each call in the file its type is in.
 * The cost model is here: `chargeFor` is what one fill came to,
 * `scheduleFromDeclaration` is the declaration's own commission as the one kind
 * of schedule this module evaluates, and `scheduleProblem` is what a schedule
 * is refused for before the first bar. The round trips, the equity curve, the
 * statistics and the report land beside their own shapes the same way.
 *
 * The shapes were agreed before any of it computed, because they are what the
 * engine, the backtest driver and a second engine all have to agree about.
 */
export { chargeFor, scheduleFromDeclaration, scheduleProblem } from './charges.js';
export { tradesOf } from './trades.js';
export { equityOver } from './equity.js';
export { monthlyOver } from './monthly.js';
export { markersOf } from './markers.js';
export { analysisOf } from './analysis.js';
export { summaryOf } from './statistics.js';
export { reportOf } from './report.js';
//# sourceMappingURL=index.js.map