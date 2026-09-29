import { isTerminal } from './row.js';
function sideOf(signed) {
    return signed > 0 ? 'buy' : 'sell';
}
/**
 * Every position reference this leg holds, oldest first.
 *
 * Oldest first is the order the references were minted in, which is the order
 * the rows first name them in, and it is the order a reducing order takes them
 * in: the position opened first is the position closed first.
 *
 * A reference with nothing left on it is not here. It has no room for an
 * opposing order and nothing for a close to send, and it is either already back
 * at zero or has its whole quantity spoken for by orders that are still going.
 */
export function holdings(ctx) {
    const tallies = new Map();
    const minted = [];
    for (const row of ctx.rows()) {
        let tally = tallies.get(row.positionRef);
        if (tally === undefined) {
            tally = {
                settled: ctx.sizeOf(row.positionRef),
                working: 0,
                against: 0,
                unreadable: null,
                blocked: false,
            };
            tallies.set(row.positionRef, tally);
            minted.push(row.positionRef);
        }
        // An order that has ended has nothing more coming from it, whatever it
        // filled: the fill is already in the settled figure above, and the rest is
        // released. That is how a strategy whose order was rejected gets its room
        // back.
        if (isTerminal(row.status))
            continue;
        const sign = row.side === 'buy' ? 1 : -1;
        // **Every row is read the same way, by the order's own quantity in units**,
        // because this sum is compared against what has settled on this reference
        // and both halves have to fall together when a fill arrives.
        //
        // A reduction used to be read by what it claimed of the leg when it was
        // sent (`row.ts`, `Reduction`), which is a number about the leg rather than
        // about the order: a second stated close claims nothing, because the first
        // already spoke for the whole leg, and it still fills and still takes what
        // it filled off what has settled here. The settled half fell, the claimed
        // half did not, the sum went negative, the reference read as the side it is
        // not on, and an entry opposing it was handed it as an order that adds. It
        // then opened long and settled short with every order answered in full.
        const remaining = row.units === null ? null : Math.max(0, row.units - row.filledQty);
        const reduces = Math.sign(tally.settled) === -sign;
        if (remaining === null) {
            tally.unreadable = row.side;
            // Nothing is sent against a position an order the engine cannot read is
            // working against. Between a close that sends nothing and an order that
            // crosses zero, `stdlib.md` 17.1 has already chosen.
            if (reduces)
                tally.blocked = true;
            continue;
        }
        tally.working += sign * remaining;
        if (reduces)
            tally.against += remaining;
    }
    const held = [];
    for (const ref of minted) {
        const tally = tallies.get(ref);
        const outstanding = tally.settled + tally.working;
        if (outstanding === 0 && tally.unreadable === null)
            continue;
        const side = outstanding === 0 ? tally.unreadable : sideOf(outstanding);
        // A reference holding a quantity the engine cannot read holds an unknown
        // number of units, and understating it is the safe half of that: an
        // opposing order divided against too small a number opens the remainder on
        // a reference of its own, which crosses nothing.
        const units = outstanding === 0 ? null : Math.abs(outstanding);
        // **What a close may send is what settled here and is not already coming
        // off**, and only where what settled is on this side. A reference whose
        // working orders run past its settled quantity reads as the other side,
        // because that is what it will hold, and nothing of that side has settled
        // yet: a reference two long with nine of sell working offered a close seven
        // units to send against it, which took its own book to five long.
        const facing = side === 'buy' ? 1 : -1;
        const settled = tally.blocked || Math.sign(tally.settled) !== facing
            ? 0
            : Math.max(0, Math.abs(tally.settled) - tally.against);
        held.push({ ref, side, units, settled });
    }
    return held;
}
/**
 * The references an order of this side reduces, oldest first.
 *
 * A reference is reduced by the side it is not on, which is the same test a
 * close makes on the leg as a whole and is why `closingSide` and this agree.
 */
export function opposing(book, side) {
    return book.filter((one) => one.side !== side);
}
/**
 * The position an order the engine cannot size is sent against, `stdlib.md`
 * 17.1, or none where the leg names no position at all.
 *
 * **A close is never minted a position of its own.** It is named for reducing,
 * so it goes on the position it is closing, and where the engine cannot read
 * the quantity it states, that position is the one the order may take past
 * zero: the one shape of 17.1 an engine does not keep, waiting on the lot size
 * OS7005 is deferred on.
 *
 * **What has settled comes first, and the book's own list second.** A reference
 * whose settled quantity is entirely spoken for by orders that are still going
 * is not in the book above, because it has nothing left for an engine-sized
 * close to send. An order the engine cannot size is not choosing a quantity, so
 * that exclusion does not apply to it: the position it is closing is still that
 * one. Taking the book's answer alone sent a close on a reference an entry was
 * opening on the other side, which is an order named close adding to a
 * position: with the leg's whole long inside a close the destination still had,
 * `close(qty = 1)` in cash was handed the reference a short entry had just
 * opened, and was a sell on it.
 *
 * A reference with nothing settled either way is the second answer rather than
 * the first, because a position being opened is a position under 17.1 and an
 * order that reduces the leg has to name one of them.
 */
export function outgoingFor(ctx, book, side) {
    const facing = side === 'buy' ? -1 : 1;
    const seen = new Set();
    for (const row of ctx.rows()) {
        if (seen.has(row.positionRef))
            continue;
        seen.add(row.positionRef);
        if (Math.sign(ctx.sizeOf(row.positionRef)) === facing)
            return row.positionRef;
    }
    return opposing(book, side)[0]?.ref ?? null;
}
/**
 * The position a bracket protects, or none where the leg holds none,
 * `stdlib.md` 17.7 and `host-interface.md` 7.1.
 *
 * **Holding first, opening second, which is the order 17.7 states them in.** A
 * bracket appends no row and moves no position, so it has nothing of its own to
 * name: it names what the leg has, and what the leg has is what its own fills
 * settled. Only where nothing has settled at all is the answer the position the
 * leg is opening, which is the ordinary shape of an `exit()` written beside the
 * entry it protects.
 *
 * **The newest of them where the leg holds more than one**, which it does
 * whenever an order that opposes it is outstanding. The newest is the one an
 * entry on that side would join (`joining`), so a bracket set after an entry
 * names the position that entry is in.
 *
 * **Derived here rather than kept as the last reference minted.** A stored slot
 * answered neither question: it was set by the mint and cleared when that one
 * reference returned to zero, so a leg whose newer position closed while an
 * older one was still held was reported as holding none, and `exit()` handed a
 * host `0` with ten units on the books. The mirror of it is the same slot read
 * the other way: a reference minted for an order the destination then refused
 * stayed the answer, and the bracket named a position that never opened while
 * the leg's own sat on another reference. Neither needs a slot to answer, and
 * both are wrong in the direction a host cannot check: `0` says the leg holds
 * nothing, and 7.1 tells a host to look a reference up only when it is not `0`.
 */
export function protecting(ctx) {
    let held = null;
    const seen = new Set();
    for (const row of ctx.rows()) {
        if (seen.has(row.positionRef))
            continue;
        seen.add(row.positionRef);
        // Rows are oldest first and references are minted in order, so the last one
        // this loop keeps is the newest reference something has settled on.
        if (ctx.sizeOf(row.positionRef) !== 0)
            held = row.positionRef;
    }
    if (held !== null)
        return held;
    const book = holdings(ctx);
    return book.length === 0 ? null : book[book.length - 1].ref;
}
/**
 * The reference an order that adds to a position joins, or none to mint one.
 *
 * The newest open reference on that side, so that two entries sent on two bars
 * before either fills belong to one position rather than to two, which is what
 * `stdlib.md` 17.7 means by a reference being kept while a position is being
 * opened.
 *
 * **A reference whose whole quantity is already going is not open to join.** A
 * leg long ten with a close of ten working is on its way out: an entry joining
 * it would settle into a position that reaches zero and ends, and 17.7's
 * sentence would then have to happen twice for one reference. The entry takes a
 * reference of its own, and if the close is rejected the leg simply holds two
 * positions on one side, each of which a close can still send.
 */
export function joining(book, side) {
    for (let index = book.length - 1; index >= 0; index -= 1) {
        const one = book[index];
        if (one.side === side)
            return one.ref;
    }
    return null;
}
/**
 * How a quantity is divided across the references it reduces, oldest first.
 *
 * **A reducing order that spans two positions is two orders**, for the reason
 * 17.1 already gives for a flip: one order against two positions would leave a
 * late fill with no way to say which of them it settled. A leg holds more than
 * one position whenever an order that opposes it is outstanding, and before
 * this the whole of a leg's closable quantity was attached to a single
 * reference with nothing asking whether that reference could absorb it.
 *
 * `room` is which of the two numbers a holding offers is the ceiling here: what
 * an opposing order may take, or what has settled. The caller chooses, because
 * the caller knows whether the quantity is the script's or the engine's.
 *
 * What is left over when every reference is full is the caller's to open or to
 * drop. Nothing is ever sent past a reference's own ceiling.
 */
export function divide(book, side, units, room) {
    const shares = [];
    let left = units;
    for (const one of opposing(book, side)) {
        if (left <= 0)
            break;
        const ceiling = room(one);
        if (ceiling === null || ceiling <= 0)
            continue;
        const take = Math.min(left, ceiling);
        shares.push({ ref: one.ref, units: take });
        left -= take;
    }
    return { shares, left };
}
//# sourceMappingURL=holdings.js.map