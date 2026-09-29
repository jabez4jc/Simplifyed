/**
 * The round trips a run's fills make up, in the order they opened.
 *
 * `charges[index]` is the money `fills[index]` was charged, rounded once by
 * whoever computed it, so the two travel as one thing and nothing here rounds
 * anything a second time. A caller with no cost model supplies no charges at
 * all and every trade's charges are zero.
 *
 * The fills are read in `seq` order whatever order they are handed in, because
 * `seq` is the order the engine folded them and a report that depended on the
 * order a caller happened to be holding them in would not be reproducible. The
 * marks are read in bar order for the same reason, and a bar is marked after
 * every fill up to it has been folded, because a fill happens during its bar
 * and the close comes after.
 */
export function tradesOf(fills, charges, marks, contract) {
    const settled = inSeqOrder(fills, charges);
    const built = [];
    const live = [];
    let next = 0;
    for (const bar of inBarOrder(marks)) {
        while (next < settled.length) {
            const one = settled[next];
            if (one === undefined || one.fill.barIndex > bar.barIndex)
                break;
            fold(one, built, live);
            next += 1;
        }
        // A bar with no close is not a price anything can be marked at. It marks
        // nothing rather than marking zero, which would read as a total loss.
        if (bar.close !== null)
            markTo(live, bar.close, contract.pointValue);
    }
    for (; next < settled.length; next += 1) {
        const one = settled[next];
        if (one !== undefined)
            fold(one, built, live);
    }
    return built.map((trade) => finish(trade, contract));
}
function inSeqOrder(fills, charges) {
    const paired = fills.map((fill, index) => ({ fill, charge: charges[index] ?? 0 }));
    return paired.sort((a, b) => a.fill.seq - b.fill.seq);
}
function inBarOrder(marks) {
    return marks.slice().sort((a, b) => a.barIndex - b.barIndex);
}
/**
 * How much of a move from one size to another closed what was held.
 *
 * Exported to the module and not through its door: `markers.ts` asks the same
 * question of the same fills, and the rule for what a move closed and what it
 * opened is one rule. Two folds may read a fill differently and produce a
 * marker for an entry the trade list calls an exit, so they read it here.
 *
 * A move to the other side of zero closed all of it, which is the case a
 * destination that overfilled produces and the one this has to get right.
 */
export function closedBy(before, after) {
    if (before === 0)
        return 0;
    const same = Math.sign(after) === Math.sign(before);
    return same ? Math.max(0, Math.abs(before) - Math.abs(after)) : Math.abs(before);
}
/** And how much of it opened something, which is the rest of the same move. */
export function openedBy(before, after) {
    if (after === 0)
        return 0;
    if (before === 0 || Math.sign(after) !== Math.sign(before))
        return Math.abs(after);
    return Math.max(0, Math.abs(after) - Math.abs(before));
}
/** One fill against the trades its reference holds. */
function fold(one, built, live) {
    const fill = one.fill;
    const closing = closedBy(fill.refSizeBefore, fill.refSizeAfter);
    const opening = openedBy(fill.refSizeBefore, fill.refSizeAfter);
    const at = live.findIndex((trade) => trade.positionRef === fill.positionRef);
    const held = at < 0 ? null : (live[at] ?? null);
    let paid = false;
    if (held !== null && closing > 0) {
        held.exitUnits += closing;
        held.exitCost += closing * fill.price;
        held.exits += 1;
        held.charges += one.charge;
        paid = true;
        // What the reference left this trade holding: nothing at all when the fill
        // carried it through zero, since the other side of zero is the next trade.
        held.size = opening > 0 ? 0 : fill.refSizeAfter;
        if (held.size === 0) {
            held.closedOnBar = fill.barIndex;
            held.closedAt = fill.barTime;
            live.splice(at, 1);
        }
    }
    if (opening > 0) {
        // A fill that closed something opens a trade of its own rather than adding
        // to the one it just finished.
        const adding = closing > 0 ? null : held;
        if (adding === null) {
            const fresh = begin(fill, opening, built.length + 1);
            built.push(fresh);
            live.push(fresh);
            if (!paid)
                fresh.charges += one.charge;
        }
        else {
            adding.entryUnits += opening;
            adding.entryCost += opening * fill.price;
            adding.entries += 1;
            adding.size = fill.refSizeAfter;
            if (!paid)
                adding.charges += one.charge;
        }
        return;
    }
    // A fill that moved nothing still cost something, and it cost it on account
    // of the trade its reference is holding.
    if (!paid && held !== null)
        held.charges += one.charge;
}
function begin(fill, units, index) {
    return {
        index,
        positionRef: fill.positionRef,
        side: fill.refSizeAfter > 0 ? 'long' : 'short',
        openedOnBar: fill.barIndex,
        openedAt: fill.barTime,
        closedOnBar: null,
        closedAt: null,
        entryUnits: units,
        entryCost: units * fill.price,
        exitUnits: 0,
        exitCost: 0,
        entries: 1,
        exits: 0,
        charges: 0,
        size: fill.refSizeAfter,
        maxFavourable: 0,
        maxAdverse: 0,
    };
}
/** Every open trade against one bar's close. */
function markTo(live, close, pointValue) {
    for (const trade of live) {
        const entry = averageOf(trade.entryCost, trade.entryUnits);
        const excursion = (close - entry) * trade.size * pointValue;
        if (excursion > trade.maxFavourable)
            trade.maxFavourable = excursion;
        if (excursion < trade.maxAdverse)
            trade.maxAdverse = excursion;
    }
}
function averageOf(cost, units) {
    return units === 0 ? 0 : cost / units;
}
function finish(trade, contract) {
    const entryPrice = averageOf(trade.entryCost, trade.entryUnits);
    const exitPrice = trade.exitUnits === 0 ? null : trade.exitCost / trade.exitUnits;
    const way = trade.side === 'long' ? 1 : -1;
    const gross = exitPrice === null
        ? 0
        : (exitPrice - entryPrice) * trade.exitUnits * contract.pointValue * way;
    return {
        index: trade.index,
        positionRef: trade.positionRef,
        side: trade.side,
        openedOnBar: trade.openedOnBar,
        openedAt: trade.openedAt,
        closedOnBar: trade.closedOnBar,
        closedAt: trade.closedAt,
        barsHeld: trade.closedOnBar === null ? null : trade.closedOnBar - trade.openedOnBar,
        units: trade.entryUnits,
        entryPrice,
        exitPrice,
        entries: trade.entries,
        exits: trade.exits,
        grossProfit: gross,
        charges: trade.charges,
        netProfit: gross - trade.charges,
        maxFavourable: trade.maxFavourable,
        maxAdverse: trade.maxAdverse,
        isOpen: trade.closedOnBar === null,
    };
}
//# sourceMappingURL=trades.js.map