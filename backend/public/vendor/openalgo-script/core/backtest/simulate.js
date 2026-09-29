import { testResting } from './resting.js';
/** `language.md` 13.3: a market order priced at the close of its own bar. */
const AT_CLOSE = 'close';
/**
 * The word this venue reports each ending under.
 *
 * A destination with words of its own maps them onto the vocabulary in its
 * adapter, which is where `stdlib.md` 17.7 puts the mapping because a status
 * vocabulary differs per destination. This is this one's, and the whole of what
 * a schedule's verb means.
 */
const ENDED = {
    reject: 'rejected',
    cancel: 'cancelled',
    expire: 'expired',
};
/**
 * A venue, for one run.
 *
 * It holds the orders it was handed and nothing else: no position, no money and
 * no view of what the strategy is doing, because a destination has none of
 * those about somebody else's strategy.
 */
export class Simulator {
    options;
    orders = [];
    /** The intents handed over, in the order they were, whatever became of them. */
    intents = [];
    /** Brackets, held so that a run can say how many it was handed and answered. */
    brackets = [];
    queued = [];
    answered = [];
    refs = 0;
    seq = 0;
    constructor(options) {
        this.options = options;
    }
    /** Step 9: what the strategy decided reaches the venue. */
    route(effect, barIndex) {
        for (const intent of effect.intents) {
            this.intents.push(intent);
            if (intent.kind === 'bracket') {
                this.brackets.push(intent);
                continue;
            }
            if (intent.kind === 'cancel') {
                this.withdraw(intent, barIndex);
                continue;
            }
            this.accept(intent, barIndex);
        }
    }
    /**
     * The frames a boundary hands over: everything this venue can say now.
     *
     * The orders that were already resting are decided against this bar first and
     * the orders this bar sent are answered after, which is the order the venue
     * learned of them in.
     */
    framesFor(barIndex) {
        const bar = this.options.bars[barIndex];
        if (bar !== undefined) {
            for (const order of this.orders) {
                // An order the schedule names is answered by the schedule, whether or
                // not it is still live: a fill after a cancellation is the one thing
                // this exists for and the order is dead by then.
                if (order.acts.length > 0) {
                    if (order.placedOn < barIndex)
                        this.perform(order, bar, barIndex);
                    continue;
                }
                if (!order.live || order.rest === null || order.placedOn >= barIndex)
                    continue;
                this.decide(order, bar, barIndex);
            }
        }
        const sent = this.queued;
        this.queued = [];
        for (const order of sent)
            this.open(order, barIndex);
        const out = this.answered;
        this.answered = [];
        return out;
    }
    /** How many orders this venue is still holding, which a run reports. */
    get working() {
        return this.orders.filter((order) => order.live).length;
    }
    /** An order the strategy sent, which this venue now holds. */
    accept(intent, barIndex) {
        this.refs += 1;
        // The ordinal of this order among the orders taken, which is what an act
        // names. Read before the order joins them, so the first is one.
        const ordinal = this.orders.length + 1;
        const order = {
            intent,
            ref: refOf(this.refs),
            placedOn: barIndex,
            rest: restingFor(intent),
            acts: (this.options.fill.schedule ?? []).filter((act) => act.order === ordinal),
            filledQty: 0,
            avgPrice: null,
            live: true,
            triggered: false,
        };
        this.orders.push(order);
        this.queued.push(order);
    }
    /**
     * A cancellation, which is about the orders a tag names and not about itself.
     *
     * Every live order carrying the tag is withdrawn and answered, which is what
     * releases the position they were claiming, and the cancellation is then
     * answered as an order of its own, because the engine appended a row for it
     * and a row nothing ever answers stays at `placed` for the life of the run.
     */
    withdraw(intent, barIndex) {
        for (const order of this.orders) {
            if (!order.live || order.intent.tag !== intent.tag)
                continue;
            order.live = false;
            this.say(order.intent, order.ref, 'cancelled', order.filledQty, null, barIndex);
        }
        // The cancellation is confirmed after what it withdrew, which is the order
        // a venue does it in: the request is answered once it has been carried out.
        this.refs += 1;
        this.say(intent, refOf(this.refs), 'cancelled', 0, null, barIndex);
    }
    /**
     * The first thing a venue says about an order it has taken.
     *
     * A working frame before any fill, because 7.4 asks for a frame on every
     * change of status and a script waiting for a working order to clear waits
     * blind without one. A market order is then filled in the same breath where
     * the declaration prices it at this bar's close, and at the next bar's open
     * where it does not.
     */
    open(order, barIndex) {
        // A scheduled order is answered by its schedule from its first breath. The
        // acknowledgement below is a thing this venue chooses to say, so a schedule
        // that wants one states it, and one that wants the destination to sit on an
        // order and say nothing gets that instead.
        if (order.acts.length > 0) {
            const bar = this.options.bars[barIndex];
            if (bar !== undefined)
                this.perform(order, bar, barIndex);
            return;
        }
        this.say(order.intent, order.ref, 'working', 0, null, barIndex);
        if (order.rest !== null)
            return;
        const atClose = this.options.fillOn === AT_CLOSE;
        const bar = this.options.bars[atClose ? barIndex : barIndex + 1];
        const price = atClose ? (bar?.close ?? null) : (bar?.open ?? null);
        // A market order sent on the last bar of a run and priced at the next open
        // has no next open. It stays working and is reported as an order the run
        // ended holding, which is what it is.
        if (price === null)
            return;
        this.complete(order, this.worsen(price, order.intent.side), barIndex);
    }
    /** One resting order against one bar. */
    decide(order, bar, barIndex) {
        const rest = order.rest;
        if (rest === null)
            return;
        const outcome = testResting(order.triggered ? asLimit(rest) : rest, bar, this.options.fill);
        if (!outcome.filled) {
            if (outcome.triggered)
                order.triggered = true;
            return;
        }
        const price = outcome.slips ? this.worsen(outcome.price, order.intent.side) : outcome.price;
        this.complete(order, price, barIndex);
    }
    /**
     * The whole of an order, filled at one price.
     *
     * **The quantity is converted into units here, because that is what a fill
     * is counted in and what every money figure is folded over.** A quantity
     * travels in the declaration's own unit (`host-interface.md` 7.1) and the
     * destination is the party that converts it. This filled the number verbatim,
     * so a strategy sizing in lots on a lot of sixty five traded one sixty fifth
     * of what it asked for and the whole report was out by that factor. The units
     * this destination cannot arrive at are refused before the first bar rather
     * than guessed at here, so by this point the unit is one of two.
     */
    complete(order, price, barIndex) {
        const qty = this.unitsOf(order.intent);
        order.filledQty = qty;
        order.avgPrice = price;
        order.live = false;
        this.say(order.intent, order.ref, 'filled', qty, price, barIndex);
    }
    /**
     * The acts due at this boundary, in the order the schedule stated them.
     *
     * Due is counted from the bar that sent the order, so an act names a moment
     * in the life of its own order rather than a bar of the run. Two acts due
     * together are answered as written, which is how a schedule states a
     * cancellation and the fill that raced it.
     *
     * Liveness is not consulted. An order that has ended can still be spoken
     * about, because the frame that arrives after it ended is the whole reason
     * this is here: `stdlib.md` 17.8's fill after a terminal status, which a
     * venue sends whenever a cancel races a fill and which an engine refusing it
     * loses, leaving a position the strategy cannot see.
     */
    perform(order, bar, barIndex) {
        for (const act of order.acts) {
            if (order.placedOn + act.afterBars !== barIndex)
                continue;
            if (act.does === 'fill') {
                this.report(order, act, bar, barIndex);
                continue;
            }
            // The order ends, reporting what it filled before it ended, because a
            // frame is cumulative: `stdlib.md` 17.8 has the row keeping the terminal
            // word and the quantity recording what traded, both true at once.
            order.live = false;
            const ended = ENDED[act.does];
            const price = order.filledQty > 0 ? order.avgPrice : null;
            this.say(order.intent, order.ref, ended, order.filledQty, price, barIndex, act.text ?? '');
        }
    }
    /**
     * A fill the schedule stated, at this bar's close and worsened like any other.
     *
     * **The average is this venue's own, over the cumulative quantity**, the
     * figure `stdlib.md` 17.8 step 3 says the row takes whole. A venue reporting
     * the last piece's price and calling it an average hands the engine a number
     * that is not one, and the engine may not work its own out from two of them,
     * so the lie settles into the ledger and into every trade folded from it.
     *
     * A stated quantity at or below what this venue has already reported adds
     * nothing and moves nothing: that is a repeated or a stale frame, which a real
     * destination sends and the fold has to swallow. It carries the average this
     * venue holds now rather than then, because it keeps no history of its own
     * averages and the fold ignores the price of a frame adding no quantity. A
     * bar with no close prices nothing, so an act due at one says nothing rather
     * than raising a quantity with no price against it, which step 3 refuses.
     */
    report(order, act, bar, barIndex) {
        const whole = this.unitsOf(order.intent);
        const stated = act.units ?? whole;
        const delta = stated - order.filledQty;
        if (delta > 0) {
            if (bar.close === null)
                return;
            // Written in this order and left in it: the source order of a sum is
            // what decides its last bit, and a case harvested from this venue is
            // asserted to the bit.
            const price = this.worsen(bar.close, order.intent.side);
            order.avgPrice = ((order.avgPrice ?? 0) * order.filledQty + price * delta) / stated;
            order.filledQty = stated;
            if (order.filledQty >= whole)
                order.live = false;
        }
        // `working` is live and not completely filled, `filled` is the whole
        // quantity: 17.7's two words read off the quantity rather than stated
        // twice by a schedule that could disagree with the number beside them.
        const status = order.filledQty >= whole ? 'filled' : 'working';
        const price = stated > 0 ? order.avgPrice : null;
        this.say(order.intent, order.ref, status, stated, price, barIndex, act.text ?? '');
    }
    /**
     * The order's quantity in units, which is what a fill is counted in.
     *
     * The conversion `complete` did inline, wanted in two places the moment a
     * schedule can fill an order in pieces: the whole a piece is measured
     * against has to be the number the fill path would have reported.
     */
    unitsOf(intent) {
        const stated = intent.qty ?? 0;
        const lot = this.options.contract.lotSize;
        return this.options.qtyType === 'lots' && lot !== null && lot > 0 ? stated * lot : stated;
    }
    /**
     * A price worsened by the slippage the run was carried out under.
     *
     * **Adverse always: a buy pays more and a sell receives less.** The sign is
     * taken as written rather than as a magnitude, because a slippage below zero
     * is refused before the first bar and taking its magnitude here would be this
     * function quietly covering for a hole in that refusal. It went uncovered for
     * a while: `scheduleProblem` has always refused a negative rate, and
     * `checkSettings` asked it only about a schedule the host supplied, so a
     * declaration stating a slippage of minus one improved both sides of every
     * fill and the backtest paid the strategy to trade.
     *
     * A slippage in ticks with no tick size to measure a tick in charges nothing.
     * The comment here once said that was refused before the first bar and it was
     * not; it still is not, because an instrument with no tick is a fact a host
     * may legitimately not hold, and a run that charges no slippage is a study
     * before slippage rather than a wrong answer. What has changed is that this
     * says so instead of claiming a refusal that never existed.
     */
    worsen(price, side) {
        const tick = this.options.contract.tickSize;
        if (tick === null || this.options.slippageTicks === 0)
            return price;
        const move = this.options.slippageTicks * tick;
        return side === 'sell' ? price - move : price + move;
    }
    /** One frame, cumulative, in the order this venue spoke. */
    say(intent, ref, status, filledQty, avgFillPrice, barIndex, text = '') {
        this.seq += 1;
        this.answered.push({
            intentId: intent.intentId,
            status,
            filledQty,
            avgFillPrice,
            orderRef: ref,
            sentInstrument: intent.instrument,
            sentProduct: intent.product,
            time: this.options.bars[barIndex]?.time ?? null,
            text,
            seq: this.seq,
        });
    }
}
/** This venue's own reference for an order, which the engine records and never parses. */
function refOf(count) {
    return 'ORD-' + String(count);
}
/** The resting order an intent is, or nothing where it is a market order. */
function restingFor(intent) {
    if (intent.type === null || intent.type === 'market' || intent.side === null)
        return null;
    return { side: intent.side, type: intent.type, limit: intent.limit, trigger: intent.trigger };
}
/** A stop limit that has triggered, which is a limit from that moment on. */
function asLimit(rest) {
    return { side: rest.side, type: 'limit', limit: rest.limit, trigger: null };
}
//# sourceMappingURL=simulate.js.map