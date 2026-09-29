/**
 * The positions a leg holds, folded from settled fills and from nothing else,
 * `stdlib.md` 17.1 and 17.7.
 *
 * **A fill settles the position its own order names, never whichever position
 * the leg holds now.** That is what the position reference is for: during a
 * flip a leg holds two positions at once, the outgoing one and its replacement,
 * and a fill that arrives late would otherwise be applied to the position that
 * replaced the one it belonged to.
 *
 * **Reducing a position does not move its average price.** The units that leave
 * leave at the price the position was opened at, so what remains is still the
 * average of what was bought. An engine that took the closing fill's price into
 * the average would report an entry at a price nothing was entered at, and
 * every level measured from the entry would be measured from that.
 *
 * Nothing here is money. Realised profit, equity and the trade list are
 * `stdlib.md` 17.4's planned entries, and this holds the two facts the five
 * position calls of this release read: how much is held, and at what average.
 */
export class Positions {
    held = new Map();
    next = 1;
    /**
     * The settled size of one position reference, signed the way a position is.
     *
     * **Per reference rather than per leg**, because which position an order is
     * sent against is a question about one position and the leg's net cannot
     * answer it: a leg holds more than one position whenever an order that
     * opposes it is outstanding, and two that net to zero are not the same thing
     * as no position at all. `holdings.ts` reads this beside the ledger's own
     * rows, which is the division the rest of the engine already keeps: what
     * settled is the position book's, what is working is the ledger's.
     *
     * Zero for a reference this book has never been given a fill for, which is
     * both a reference minted for an order that has not settled and one that is
     * not a reference at all.
     */
    sizeOf(ref) {
        return this.held.get(ref)?.size ?? 0;
    }
    /** A fresh position, for the replacement half of a flip. */
    mint() {
        const ref = this.next;
        this.next += 1;
        this.held.set(ref, { size: 0, cost: 0 });
        return ref;
    }
    /** Step 6 of the fold: `units` at `price` settle against one position. */
    settle(ref, units, price) {
        const position = this.held.get(ref) ?? { size: 0, cost: 0 };
        this.held.set(ref, position);
        const before = position.size;
        if (before === 0 || Math.sign(units) === Math.sign(before)) {
            position.size = before + units;
            position.cost += units * price;
        }
        else {
            const average = position.cost / before;
            const after = before + units;
            position.size = after;
            // A destination that filled more than the order asked takes the leg
            // through zero. The remainder is a position in the other direction and it
            // opened at this fill's price, which is the truthful reading of what the
            // account now holds. Dropping it would leave the strategy blind to a
            // position it is carrying.
            const held = Math.sign(after) === Math.sign(before) ? average : price;
            position.cost = after === 0 ? 0 : after * held;
        }
    }
    /** The leg's net position in units, `0` while flat. */
    size() {
        let total = 0;
        for (const position of this.held.values())
            total += position.size;
        return total;
    }
    /**
     * The average price of what the leg holds, absent while flat.
     *
     * Absent rather than zero, because zero is a price and a script comparing
     * against it would take a branch that looks correct (`stdlib.md` 17.4).
     *
     * **Averaged over the positions that make up what the leg holds**, which is
     * the ones on the side of its net, and not over every position open at once.
     * A leg holds more than one whenever an order that opposes it is outstanding:
     * during a flip it holds the outgoing position and its replacement, and where
     * the engine could not size the opposing order against the leg it holds the
     * position that order opened beside the one it was meant to replace. Summed
     * across both, the cost of a position on the way out is subtracted from the
     * cost of the one on the way in, and the quotient is a price nothing was
     * entered at: three hundred bought at one hundred with two hundred and
     * twenty five sold at one hundred and ten reported an entry at seventy, and
     * every level a script measures from the entry would have been measured from
     * it. Reducing a position does not move its average, and that is the same
     * sentence read across a leg rather than inside one position.
     */
    avgPrice() {
        const net = this.size();
        if (net === 0)
            return null;
        const side = Math.sign(net);
        let size = 0;
        let cost = 0;
        for (const position of this.held.values()) {
            if (Math.sign(position.size) !== side)
                continue;
            size += position.size;
            cost += position.cost;
        }
        return size === 0 ? null : cost / size;
    }
}
//# sourceMappingURL=positions.js.map