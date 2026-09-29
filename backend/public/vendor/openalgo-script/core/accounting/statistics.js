/**
 * The summary, and the two figures in it that decide whether a run means
 * anything.
 *
 * **Win rate is over closed trades, on net profit after charges**, and a trade
 * whose net is exactly zero is a scratch counted in neither half. It is null
 * where nothing closed rather than zero, because zero is a number a reader
 * compares against and "nothing has closed yet" is not a losing run.
 *
 * **Expectancy is money per closed trade**, and it has two spellings that must
 * agree: the win rate against the average win and the average loss, and the net
 * profit over the trade count. Two spellings of one figure that disagree is how
 * a report loses its reader, so one of them is the computation and the other is
 * a test, and the test says which sequence of roundings it allows for.
 *
 * **And its standard error is what answers the question a comparison asks.**
 * The sample standard deviation of per-trade net over the square root of the
 * trade count is what turns "this run made more" into "this run made more than
 * the noise", and without it a difference of two percent over eleven trades
 * reads like a result.
 *
 * Bar times rather than bar indices, wherever a figure addresses a bar: loading
 * more history shifts every index, so a report that addresses a bar by index
 * changes when the warmup changes.
 *
 * ## Which trades a figure is counted over, which is three different answers
 *
 * A summary folds a list holding closed trades and open ones together, and
 * almost every defect this file can have is a figure counted over the wrong
 * half of it.
 *
 * - **Net profit, and everything derived from it**, is over closed trades. An
 *   open trade's net is its charges so far with no gross against them, so
 *   counting it would report a run holding a winner as having lost money.
 * - **Charges are over every trade**, open ones included, because the money
 *   left the account whether or not the position came back. This is the figure
 *   the equity curve's last point carries, and the two are asserted equal.
 * - **The drawdown figures are over the curve** and not over the trades at all.
 *   A drawdown is a thing equity did between two trades as often as during one.
 *
 * ## The cases where a statistic is not a number
 *
 * Every one of them is a division, and every one of them is answered here
 * rather than left to arrive as a value JSON turns into `null`:
 *
 * - **Nothing closed.** The win rate is null, which is a different claim from
 *   zero. Expectancy and its error are zero, because the type is money and
 *   money is not nullable, and `tradeCount` beside them is the field that says
 *   whether they mean anything.
 * - **One closed trade.** A sample of one has no spread, so the standard error
 *   is zero. Zero here means not measurable, never measured: anything dividing
 *   by it checks the trade count first.
 * - **Every closed trade a scratch.** There is no denominator for a win rate,
 *   so it is null for the same reason as nothing closed.
 * - **Nothing lost.** The profit factor is null rather than an infinity, which
 *   is the same decision `spec/conformance.md` takes about absence: a value
 *   that does not survive being written down is not a value a report may hold.
 * - **Everything lost.** The profit factor is zero, expectancy is negative, the
 *   average win is zero, and none of the four is a division by zero.
 */
import { barsInMarketOver, ratioOf } from './equity.js';
/**
 * The whole run in one shape, folded from its trades and its own curve.
 *
 * The curve is passed in rather than recomputed, because a summary that folded
 * its own would be a second equity curve with a second set of rounding, and the
 * first disagreement between them would be a drawdown figure that no point in
 * the reported curve ever reached.
 */
export function summaryOf(trades, equity, contract, capital) {
    const tally = tallyOf(trades);
    const depth = depthOf(equity);
    const decided = tally.wins + tally.losses;
    // Net over the closed count, and nothing else, because this is the figure the
    // other spelling is checked against. The win rate spelling divides by the
    // decided trades instead, so the two are the same number exactly when no
    // trade scratched, and `tests/accounting/statistics.test.ts` asserts both the
    // agreement and the one case that parts them.
    const expectancy = tally.tradeCount === 0 ? 0 : tally.netProfit / tally.tradeCount;
    return {
        capital,
        currency: contract.currency,
        netProfit: tally.netProfit,
        grossProfit: tally.grossProfit,
        grossLoss: tally.grossLoss,
        charges: tally.charges,
        returnPercent: ratioOf(tally.netProfit, capital),
        tradeCount: tally.tradeCount,
        openTradeCount: tally.openTradeCount,
        wins: tally.wins,
        losses: tally.losses,
        scratches: tally.scratches,
        winRate: decided === 0 ? null : tally.wins / decided,
        averageWin: tally.wins === 0 ? 0 : tally.winTotal / tally.wins,
        averageLoss: tally.losses === 0 ? 0 : -tally.lossTotal / tally.losses,
        expectancy,
        expectancyStandardError: standardErrorOf(trades, expectancy, tally.tradeCount),
        profitFactor: tally.grossLoss > 0 ? tally.grossProfit / tally.grossLoss : null,
        maxDrawdown: depth.maxDrawdown,
        maxDrawdownPercent: depth.maxDrawdownPercent,
        maxDrawdownAt: depth.maxDrawdownAt,
        longestDrawdownBars: depth.longestDrawdownBars,
        maxRunUp: depth.maxRunUp,
        maxRunUpPercent: depth.maxRunUpPercent,
        maxRunUpAt: depth.maxRunUpAt,
        averageBarsHeld: tally.heldCount === 0 ? null : tally.heldTotal / tally.heldCount,
        barsInMarket: barsInMarketOver(trades, equity),
        barCount: equity.length,
    };
}
/**
 * One pass over the trades, in the order they are given.
 *
 * A trade wins or loses on its net after charges, and its gross is what it
 * contributes to the gross figures: "the sum of the winning trades, before
 * charges" is two statements and this is where they meet. The one arrangement
 * that reads oddly is a trade whose gross was positive and whose charges took
 * it under, which lands in the losses and takes its positive gross with it,
 * lowering the gross loss. That is on purpose. The alternative is a trade
 * counted as a loser in one figure and a winner in another, and a profit factor
 * whose two halves are counted over different sets is worse than one whose
 * magnitude is odd on a trade that barely moved.
 *
 * What is not on purpose, and is why `profitFactor` is null rather than a ratio
 * whenever this figure is not above zero: enough of those trades and the gross
 * loss reaches zero or goes under, and dividing by it reported a profit factor
 * of minus a half. A statistic being odd is a thing a reader can weigh. A
 * statistic being negative where every use of it is a non-negative ratio is a
 * number nobody can act on.
 */
function tallyOf(trades) {
    let netProfit = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    let charges = 0;
    let tradeCount = 0;
    let openTradeCount = 0;
    let wins = 0;
    let losses = 0;
    let scratches = 0;
    let winTotal = 0;
    let lossTotal = 0;
    let heldTotal = 0;
    let heldCount = 0;
    for (const trade of trades) {
        charges += trade.charges;
        if (trade.isOpen) {
            openTradeCount += 1;
            continue;
        }
        tradeCount += 1;
        netProfit += trade.netProfit;
        if (trade.barsHeld !== null) {
            heldTotal += trade.barsHeld;
            heldCount += 1;
        }
        if (trade.netProfit > 0) {
            wins += 1;
            winTotal += trade.netProfit;
            grossProfit += trade.grossProfit;
        }
        else if (trade.netProfit < 0) {
            losses += 1;
            lossTotal += trade.netProfit;
            grossLoss -= trade.grossProfit;
        }
        else {
            scratches += 1;
        }
    }
    return {
        netProfit,
        grossProfit,
        grossLoss,
        charges,
        tradeCount,
        openTradeCount,
        wins,
        losses,
        scratches,
        winTotal,
        lossTotal,
        heldTotal,
        heldCount,
    };
}
/**
 * The deepest the curve went, named as one point rather than as three figures.
 *
 * The money, the fraction and the time all come from the same point, and the
 * point is the deepest in money with the earliest one winning a tie. Taking the
 * worst fraction from one bar and the worst money from another would describe a
 * moment the run never had, and a reader comparing the two figures would find
 * them inconsistent with every point in the curve they were drawn from.
 *
 * `longestDrawdownBars` is the longest run of consecutive bars under a peak: it
 * starts at the first bar below one and ends at the bar before the recovery, so
 * a run still under water at the last bar counts to the end. It is often the
 * figure that actually stops a trader, and it is not the total number of bars
 * spent under water, which is a different and much larger number.
 */
function depthOf(equity) {
    let maxDrawdown = 0;
    let maxDrawdownPercent = 0;
    let maxDrawdownAt = null;
    let longestDrawdownBars = 0;
    let under = 0;
    let maxRunUp = 0;
    let maxRunUpPercent = 0;
    let maxRunUpAt = null;
    for (const point of equity) {
        if (point.drawdown < maxDrawdown) {
            maxDrawdown = point.drawdown;
            maxDrawdownPercent = point.drawdownPercent;
            maxDrawdownAt = point.time;
        }
        if (point.drawdown < 0) {
            under += 1;
            if (under > longestDrawdownBars)
                longestDrawdownBars = under;
        }
        else {
            under = 0;
        }
        // Strictly greater, so the earliest bar reaching the height wins the tie,
        // which is the rule the depth above is picked by. The two figures address
        // different bars and each addresses the first bar that reached it.
        if (point.runUp > maxRunUp) {
            maxRunUp = point.runUp;
            maxRunUpPercent = point.runUpPercent;
            maxRunUpAt = point.time;
        }
    }
    return {
        maxDrawdown,
        maxDrawdownPercent,
        maxDrawdownAt,
        longestDrawdownBars,
        maxRunUp,
        maxRunUpPercent,
        maxRunUpAt,
    };
}
/**
 * The standard error of the expectancy: the sample deviation over the root of
 * the count.
 *
 * The sample deviation, with the count less one under it, and not the
 * population one. The trades a run took are a sample of the trades the strategy
 * would take, which is the whole reason this figure is here, and the population
 * spelling understates the spread by exactly the amount that matters on the
 * short runs where the question is asked.
 *
 * Fewer than two closed trades has no spread to measure and gives zero.
 */
function standardErrorOf(trades, expectancy, tradeCount) {
    if (tradeCount < 2)
        return 0;
    let squares = 0;
    for (const trade of trades) {
        if (trade.isOpen)
            continue;
        const away = trade.netProfit - expectancy;
        squares += away * away;
    }
    return Math.sqrt(squares / (tradeCount - 1) / tradeCount);
}
//# sourceMappingURL=statistics.js.map