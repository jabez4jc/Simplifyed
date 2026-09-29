import { closableUnits, closingFor, closingSide } from './closable.js';
import { protecting } from './holdings.js';
import { isTerminal } from './row.js';
import { NOTHING, adding, entering, flattening } from './sizing.js';
/**
 * The type the prices imply.
 *
 * Stated on the intent rather than left to the host, so a destination never has
 * to infer it: with neither price a market order, with a limit alone a limit
 * order, with a trigger alone a stop order, and with both a stop limit order
 * (`stdlib.md` 17.2).
 */
function typeOf(limit, trigger) {
    if (limit !== null && trigger !== null)
        return 'stopLimit';
    if (limit !== null)
        return 'limit';
    if (trigger !== null)
        return 'stop';
    return 'market';
}
/**
 * A cancellation names the tag it cancels and nothing else.
 *
 * No side, no quantity and no price: it is not an order, and what becomes of
 * the order it names arrives as a frame about that order.
 */
function cancelling(tag) {
    return { ...NOTHING, kind: 'cancel', tag, positionRef: 0 };
}
/** A protective level attached to a tag, `stdlib.md` 17.2 and 17.3. */
function bracketing(ctx, tag, qty, target, stop, profit, loss) {
    // A call that names no level at all removes one, which is a standing level of
    // `stdlib.md` 17.9 and is planned. There is nothing to send.
    if (target === null && stop === null && profit === null && loss === null)
        return [];
    // Nothing has been ordered by a bracket, so it takes nothing out of the
    // position: the level it sets belongs to the leg until it is reached.
    return [
        adding({
            ...NOTHING,
            kind: 'bracket',
            qty,
            qtyType: qty === null ? 'units' : ctx.qtyType,
            target,
            stop,
            profit,
            loss,
            tag,
            // The position the level protects, and zero where the leg holds none,
            // which is the value a cancellation already carries for the same reason:
            // neither is an order and neither has a position of its own. Minting one
            // here burned a reference on an instruction that moves nothing, so a
            // script whose first call is `exit()` opened on reference 2 and the
            // bracket named a reference no order ever carried
            // (`host-interface.md` 7.1).
            //
            // **Asked of the book, because what the leg holds is not what was minted
            // last.** The reference minted last is cleared when that one reference
            // returns to zero, so a leg still holding an older position reported none
            // and a bracket went out carrying `0`, which is the one value 7.1 tells a
            // host means there is nothing to look up (`holdings.ts`, `protecting`).
            positionRef: protecting(ctx) ?? 0,
        }),
    ];
}
/**
 * The orders one call sends, in the order it sends them.
 *
 * A call that has nothing to send sends nothing: flattening a leg that holds
 * nothing and reversing a position that does not exist are both instructions
 * about a position the strategy does not hold, and inventing a side for either
 * would be the engine deciding a direction the script never stated.
 */
export function ordersFor(call, ctx) {
    const side = call.side;
    switch (call.name) {
        case 'buy':
        case 'sell':
            if (side === null)
                return [];
            return entering(ctx, {
                side,
                limit: call.limit,
                trigger: call.trigger,
                type: typeOf(call.limit, call.trigger),
                tag: call.tag ?? '',
            }, call.qty);
        case 'order.place': {
            // A side that is not one of the two is not a direction, and a buy is not
            // the safe guess: the checker refuses a written value outside the set
            // with OS3008, and a computed one that reaches here sends nothing rather
            // than sending the opposite of what the script meant. A side the script
            // stated as absent never reaches here at all: that is OS7002.
            if (side === null)
                return [];
            return entering(ctx, {
                side,
                limit: call.limit,
                trigger: call.trigger,
                // A type outside the set falls back to the one the prices imply,
                // which is the correspondence `stdlib.md` 17.2 fixes between the two.
                type: call.type ?? typeOf(call.limit, call.trigger),
                tag: call.tag ?? '',
            }, call.qty);
        }
        case 'close': {
            // **The side comes from the part the call names**, which is the leg only
            // where it names no tag. Taken from the leg's net, a close of a part
            // holding four short on a leg netting six long was a sell of four: the
            // part went to eight short, the other tag's long was cut to six, and a
            // call named close had opened position (`closable.ts`, `stdlib.md` 17.2).
            const closing = closingFor(ctx, call.tag);
            if (closing === undefined)
                return [];
            // A tag names the part of the position that tag entered, which is the
            // settled quantity of its own rows, less what is already working against
            // it. A quantity the script stated has already been held against this
            // same number by `refuse.ts`, so nothing reaching here crosses zero.
            return flattening(ctx, closableUnits(ctx, call.tag), closing, call.qty, call.tag ?? '', call.tag);
        }
        case 'order.reverse': {
            const size = ctx.size();
            const closing = closingSide(size);
            if (closing === undefined)
                return [];
            const tag = call.tag ?? '';
            // What is left to close rather than the whole leg, so that a reverse
            // after a close on the same bar does not send the position twice.
            const out = flattening(ctx, closableUnits(ctx, null), closing, null, tag, null);
            // The replacement is a position of its own, minted here, so that a fill
            // on the outgoing order settles the position it belonged to.
            const ref = ctx.mint();
            const opening = {
                ...NOTHING,
                kind: 'place',
                side: closing,
                qty: call.qty ?? Math.abs(size),
                qtyType: call.qty === null ? 'units' : ctx.qtyType,
                type: 'market',
                tag,
                positionRef: ref,
            };
            return [...out, adding(opening)];
        }
        case 'exit':
            return bracketing(ctx, call.tag ?? '', call.qty, call.target, call.stop, call.profit, call.loss);
        case 'order.bracket':
            return bracketing(ctx, call.tag ?? '', null, null, null, call.profit, call.loss);
        case 'cancel':
            return [adding(cancelling(call.tag ?? ''))];
        case 'cancelAll': {
            const tags = [];
            for (const row of ctx.rows()) {
                if (!isTerminal(row.status) && !tags.includes(row.tag))
                    tags.push(row.tag);
            }
            return tags.map((tag) => adding(cancelling(tag)));
        }
        default:
            return [];
    }
}
/** The intent one placement becomes, `host-interface.md` 7.1. */
export function intentFor(placement, intentId, ctx) {
    return {
        ...placement,
        intentId,
        instrument: ctx.instrument,
        product: ctx.product,
        bar: ctx.bar,
    };
}
//# sourceMappingURL=place.js.map