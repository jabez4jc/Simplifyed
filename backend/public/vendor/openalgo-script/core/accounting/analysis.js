/**
 * The trades taken apart: by direction, by extreme, and by run.
 *
 * The summary answers what the whole run did. Three questions it cannot answer
 * are asked here, and each of them is a question about whether the summary
 * means what it looks like it means.
 *
 * **Which side made the money.** A run whose long trades paid for its short
 * ones reports a healthy net and is two strategies, one of which is losing. The
 * summary cannot show that, because every figure in it is folded over both
 * sides at once. Splitting it is not a refinement of the headline number, it is
 * the first thing that can contradict it.
 *
 * **Whether one trade is the result.** A hundred trades and a profit factor of
 * two reads as an edge until the largest win is the whole of the net. The
 * expectancy's standard error already says how wide the spread is; the largest
 * win and the largest loss say where the width came from, which is the part a
 * reader can act on.
 *
 * **What the run of losses was.** The deepest drawdown is a money figure and
 * the longest one is a bar count, and neither is the number that actually stops
 * somebody trading a strategy. That number is how many times in a row it was
 * wrong. It is not derivable from anything in the summary: the same win rate
 * over the same trades gives a streak of two or a streak of eleven depending on
 * an ordering the summary folds away.
 *
 * ## Every figure here is over closed trades, and that is the whole rule
 *
 * An open trade has no net to win or lose by, so it is in none of these counts,
 * on either side, in no streak and in no extreme. `statistics.ts` has three
 * different answers to which trades a figure is counted over, because a summary
 * carries a capital figure and a bar count that are facts about the run rather
 * than about its trades. Nothing here is a fact about the run, so there is one
 * answer, and a reader can hold it.
 *
 * The consequence worth stating: `longCount + shortCount` is `tradeCount` and
 * not the length of the list folded. A run holding an open position reports
 * fewer trades here than it has, and the summary's `openTradeCount` is where
 * the difference is accounted for.
 */
function emptySide() {
    return { count: 0, wins: 0, losses: 0, scratches: 0, netProfit: 0 };
}
function sideOf(tally) {
    const decided = tally.wins + tally.losses;
    return {
        count: tally.count,
        wins: tally.wins,
        losses: tally.losses,
        scratches: tally.scratches,
        netProfit: tally.netProfit,
        winRate: decided === 0 ? null : tally.wins / decided,
    };
}
/**
 * One pass over the closed trades, in closing order.
 *
 * The list arrives in opening order, which is what the equity fold needs and
 * what `tradesOf` produces. The streaks need closing order, so the closed
 * trades are ordered here rather than anywhere else: reordering the list the
 * caller holds would change the equity curve, and taking a second list in
 * opening order and calling its streaks correct would be the defect this
 * function is supposed to have caught.
 *
 * A trade whose net is exactly zero is a scratch, which is the summary's rule
 * and is applied here for the same reason. A scratch **breaks** a streak
 * without extending either one: a strategy that went right, flat, right was not
 * right twice running, and counting the flat trade as either would make the
 * streak a figure that depends on a rounding at the last digit.
 */
export function analysisOf(trades) {
    const long = emptySide();
    const short = emptySide();
    let largestWin = 0;
    let largestLoss = 0;
    let maxConsecutiveWins = 0;
    let maxConsecutiveLosses = 0;
    let winStreak = 0;
    let lossStreak = 0;
    const closed = trades.filter((trade) => !trade.isOpen).slice();
    // A trade closes on a bar, and two can close on the same one. The opening
    // order breaks the tie, because it is the order the list arrived in and the
    // only other fact available: a sort that is not total gives two engines two
    // different streaks from one list of trades.
    closed.sort((a, b) => (a.closedOnBar ?? 0) - (b.closedOnBar ?? 0) || a.index - b.index);
    for (const trade of closed) {
        const side = trade.side === 'long' ? long : short;
        side.count += 1;
        side.netProfit += trade.netProfit;
        if (trade.netProfit > 0) {
            side.wins += 1;
            if (trade.netProfit > largestWin)
                largestWin = trade.netProfit;
            winStreak += 1;
            lossStreak = 0;
            if (winStreak > maxConsecutiveWins)
                maxConsecutiveWins = winStreak;
        }
        else if (trade.netProfit < 0) {
            side.losses += 1;
            if (-trade.netProfit > largestLoss)
                largestLoss = -trade.netProfit;
            lossStreak += 1;
            winStreak = 0;
            if (lossStreak > maxConsecutiveLosses)
                maxConsecutiveLosses = lossStreak;
        }
        else {
            side.scratches += 1;
            winStreak = 0;
            lossStreak = 0;
        }
    }
    return {
        long: sideOf(long),
        short: sideOf(short),
        largestWin,
        largestLoss,
        maxConsecutiveWins,
        maxConsecutiveLosses,
    };
}
//# sourceMappingURL=analysis.js.map