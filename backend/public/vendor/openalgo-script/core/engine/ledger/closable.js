import { isTerminal, workingUnits } from './row.js';
/**
 * The side that reduces a position, or nothing when there is none to reduce.
 *
 * One fact with two readers. The mapping uses it to give a close its direction,
 * and the arithmetic below uses it to tell an order that is on its way out of
 * the position from one that is on its way in, which is the difference between
 * a reduction that is still working and an entry that holds nothing.
 */
export function closingSide(size) {
    if (size > 0)
        return 'sell';
    if (size < 0)
        return 'buy';
    return undefined;
}
/** The settled units held under one tag, signed the way a position is. */
function heldUnder(ctx, tag) {
    let held = 0;
    for (const row of ctx.rows()) {
        if (row.tag !== tag)
            continue;
        held += row.side === 'buy' ? row.filledQty : -row.filledQty;
    }
    return held;
}
/**
 * What the part a call names holds, signed the way a position is.
 *
 * The leg where the call names no tag, and the settled quantity of that tag's
 * own rows where it names one. **One function because it is one question**, and
 * every number this file produces about a part is taken from it: how much is
 * there to close, which side reduces it, and how much of it an order the engine
 * cannot read is assumed to have taken.
 */
function holdingOf(ctx, tag) {
    return tag === null ? ctx.size() : heldUnder(ctx, tag);
}
/**
 * The side that reduces the part a call names, or nothing where it holds none.
 *
 * **The direction of a close comes from the part it was told to flatten**, and
 * taking it from the leg is how a call named `close` opened a position: a leg
 * holding ten long under one tag and four short under another is a net six
 * long, so `close(tag)` on the short part was answered with a sell, which took
 * that part to eight short and cut the other one to six. `stdlib.md` 17.2 says
 * the call flattens the part of the position carrying one tag, and says of the
 * reading that takes the leg's net that it would let close open a position.
 *
 * A part whose own rows have netted to nothing has no side and the call sends
 * nothing, which is 17.2's idempotence and the same answer a flat leg gives a
 * bare close.
 */
export function closingFor(ctx, tag) {
    return closingSide(holdingOf(ctx, tag));
}
/**
 * The units already working against the position, across the whole run.
 *
 * Every reduction comes out of the leg, and a reduction naming a tag comes out
 * of that tag as well, so the leg is asked with no tag and a part is asked with
 * its own.
 *
 * **Only an order on the side that reduces what the leg holds now**, and
 * **every** order on that side. A row records what it reduced at the moment it
 * was sent, and a leg that has changed sign since is being reduced from the
 * other side: an order still working on the old side is adding to the leg
 * rather than taking from it, and subtracting it would leave a close sending
 * less than there is to close. The same sentence read the other way is the
 * half that was missing. An order recorded as adding to a position, on a leg
 * that has since gone the other way, is a reduction now whatever it was then,
 * and leaving it out let a close be sized against a position an entry was
 * already coming to take off: `buy(qty = 5)` unanswered on a leg the sells
 * after it took short offered a close the whole twelve, five of which were
 * already on their way.
 *
 * **The side is the part's own**, which is the leg's where no tag names one. A
 * part can sit on the side its leg is not on, and then the orders that reduce
 * it are the ones the leg's net calls additions: measured from the leg, the
 * count for a short part under a long leg counted the sells that were adding to
 * it and missed the buys that were taking it off.
 *
 * `holdings.ts` makes the same reading per position reference, and the two
 * agree by construction: what a close may send across the leg is never more
 * than the positions on that side can give it.
 */
function committed(ctx, tag) {
    const held = holdingOf(ctx, tag);
    const side = closingSide(held);
    if (side === undefined)
        return { units: 0, counted: true };
    let units = 0;
    let counted = true;
    for (const row of ctx.rows()) {
        if (row.side !== side || isTerminal(row.status))
            continue;
        const reduces = row.reduces;
        if (reduces !== null) {
            if (tag !== null && reduces.part !== tag)
                continue;
            const working = workingUnits(row);
            if (working === 0)
                continue;
            units += working;
            counted = counted && reduces.counted;
            continue;
        }
        // An order that was an entry when it left. Its own tag is what names it,
        // because a reduction's `part` is the tag a close named and an entry named
        // no part of anything.
        if (tag !== null && row.tag !== tag)
            continue;
        if (row.units === null) {
            // A quantity in the declaration's own unit, working against this part and
            // unreadable as a number of units. Taken to cover the whole of what is
            // there, which is the reading `stdlib.md` 17.1 already makes for the
            // other order it cannot read: a close that sends nothing over an order
            // that crosses zero.
            units += Math.abs(held);
            counted = false;
            continue;
        }
        units += Math.max(0, row.units - row.filledQty);
    }
    return { units, counted };
}
/**
 * What a `close` can still close, in units, whether or not it names a quantity.
 *
 * The whole leg where the call names no tag, and the part that tag entered
 * where it names one, less what is already working against it. Zero while the
 * leg is flat, zero for a tag whose rows have netted to nothing, and zero once
 * the orders already sent have the whole of it going.
 *
 * **A part on the leg's own side is bounded by the leg**, so that closing a
 * part can never take the leg through zero: the part is what the call names,
 * and the leg is what the order comes out of.
 *
 * **A part on the other side is not**, and bounding it there was the second
 * half of taking a direction from the net. Closing a short part under a long
 * leg is a buy, which moves the leg away from zero rather than towards it, so
 * there is nothing for the leg's own number to bound: measured against it, a
 * part holding ten short on a leg netting two long was offered two, and on a
 * leg netting nothing at all it was offered nothing. What that order may
 * actually send is still bounded per position by what has settled there
 * (`holdings.ts`), so a part whose reference has already returned to zero sends
 * nothing rather than opening it again.
 *
 * Both readers ask this one question. The quantity a script states is refused
 * against this number (OS7017) and the quantity the engine works out for itself
 * is this number. Two readings of what a part holds would be one fact in two
 * files, and the refusal would be about a quantity the mapping was not going to
 * send.
 */
export function closable(ctx, tag) {
    const spent = committed(ctx, null);
    const leg = Math.max(0, Math.abs(ctx.size()) - spent.units);
    if (tag === null)
        return { units: leg, counted: spent.counted };
    const held = heldUnder(ctx, tag);
    const own = committed(ctx, tag);
    const part = Math.max(0, Math.abs(held) - own.units);
    if (Math.sign(held) !== Math.sign(ctx.size()))
        return { units: part, counted: own.counted };
    return part <= leg
        ? { units: part, counted: own.counted }
        : { units: leg, counted: spent.counted };
}
/** What a close can still close, for the mapping, which sends a number. */
export function closableUnits(ctx, tag) {
    return closable(ctx, tag).units;
}
//# sourceMappingURL=closable.js.map