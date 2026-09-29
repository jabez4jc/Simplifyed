import { callOf } from './call.js';
import { intentFor, ordersFor } from './place.js';
import { Positions } from './positions.js';
import { refusalInCall, refusalInOrder } from './refuse.js';
import { foldFrame } from './row.js';
export class Ledger {
    byIntent = new Map();
    placed = [];
    positions = new Positions();
    waiting = [];
    next = 1;
    options;
    /** The bar `sent` describes, so the list empties when a new one begins. */
    at = -1;
    /**
     * The orders this bar has sent, which is what OS7013 is asked about.
     *
     * The bar is the right scope for that one rule and for nothing else. What a
     * reducing order is measured against used to be read from here too, and the
     * defect that made obvious was the plainest one there is: a close still
     * working when the next bar closed again was invisible, because this list is
     * emptied the moment the bar index changes. The rows below outlive the bar
     * and say which orders the destination still has, so that reading moved to
     * `closable.ts` and this list kept the question that really is a bar's.
     */
    sent = [];
    constructor(options) {
        this.options = options;
    }
    /**
     * Step 9 sent an order call. It becomes intents, and each becomes a row.
     *
     * A row is appended when the order is sent, at `placed`, which is the
     * engine's own status: an intent has left and nothing has come back, and a
     * host cannot report a state the destination has never described.
     *
     * **The whole call is read, mapped and refused before any of it is sent.**
     * Every order the call produces is held against `refuse.ts` first, and only
     * then does any of them take an id, so a refused call appends no row and
     * returns no intent: there is nothing for a host to send and nothing to take
     * back afterwards. A call that sends two orders sends both or neither.
     *
     * **The bar is the same promise one scope up**, and `discard` below is how
     * it is kept. A refusal anywhere on a bar hands none of the bar's orders to a
     * destination, so none of the bar's rows may survive it either, including the
     * rows of calls that had already been mapped when the refusal happened. That
     * is not the ledger rewriting a record backwards: nothing was handed over, so
     * there is no record of a hand-over to rewrite.
     */
    place(name, params, args, bar, at) {
        if (bar.index !== this.at) {
            this.at = bar.index;
            this.sent = [];
        }
        const ctx = this.contextFor(bar);
        const call = callOf(name, params, args, at);
        const refused = refusalInCall(call, ctx);
        if (refused !== undefined)
            return { intents: [], refusal: refused };
        const orders = ordersFor(call, ctx);
        for (const order of orders) {
            const bad = refusalInOrder(call, order, ctx, this.sent);
            if (bad !== undefined)
                return { intents: [], refusal: bad };
        }
        const intents = [];
        for (const order of orders) {
            const intentId = this.next;
            this.next += 1;
            const intent = intentFor(order.placement, intentId, ctx);
            intents.push(intent);
            // Only an order that places one appends a row: a cancellation and a
            // bracket carry an id a host can quote and nothing has been ordered by
            // either. What a cancellation does to an order, and what a bracket's
            // level does when it is reached, both arrive as frames about orders.
            const { side, qty, type } = intent;
            if (intent.kind === 'place' && side !== null && qty !== null && type !== null) {
                // What the order takes out of the position rides on the row, because
                // the row is what outlives the bar: an order the destination has not
                // answered is still going, and the row is the only record of it.
                this.append(intent, { side, qty, type }, bar, order.reduces);
                // One entry per appended row, in the same order, which is what lets a
                // refused bar take back exactly the orders it appended.
                this.sent.push({ name: call.name, line: at.line, side });
            }
        }
        return { intents, refusal: undefined };
    }
    /**
     * The bar sent nothing after all: every row it appended is taken back.
     *
     * A refusal anywhere on a bar hands none of the bar's orders over, because
     * every call is mapped before any of them is routed (`orders.ts`). Until this
     * existed, the rows of the calls that had already been mapped stayed: a bar
     * that placed an order and then met a refusal left `orders()` reporting an
     * order at `placed` that no destination was ever handed, and a host
     * reconciling after a stopped run saw an order it never received. 17.7 says a
     * row is appended when the order is sent, and nothing had been sent.
     *
     * **Taken back rather than never written.** A row has to be there while the
     * rest of the bar is mapped: `cancel` asks whether a tag names a working
     * order, pyramiding counts the entries a position already holds, and a close
     * measures what one tag entered, all from rows this same bar may have
     * appended. Deferring the append would make an entry and a cancellation of it
     * on one bar into OS7009. So the bar writes its rows and a refused bar undoes
     * them, which is the same shape the moving bar already uses on the cells.
     *
     * The intent ids the bar minted are not reissued. An id is unique within a
     * run (`stdlib.md` 17.7), a frame that quoted one must never match a later
     * order, and a gap in the numbering is invisible to a host, so the cheap
     * invariant is the one worth keeping.
     *
     * **`from` is the row count the routing pass began at**, and it is held by
     * that pass rather than by a bar index kept here. A bar declared
     * `onUnconfirmed` applies its effects on every execution of itself, so one bar
     * can route more than once, and a mark taken when the bar index last changed
     * would take back rows whose orders a previous execution really did hand over.
     * The promise belongs to the pass that made it, so the mark does too.
     */
    discard(from) {
        const dropped = this.placed.length - from;
        if (dropped <= 0)
            return;
        for (const row of this.placed.slice(from))
            this.byIntent.delete(row.intentId);
        this.placed.length = from;
        // One row appended pushed exactly one entry here, in the same order, so the
        // orders OS7013 has seen this bar shrink by the same count.
        this.sent.length = Math.max(0, this.sent.length - dropped);
    }
    /** A frame from the destination, held until the next bar boundary. */
    deliver(frame) {
        this.waiting.push(frame);
    }
    /**
     * Folds every frame that has arrived, in the order it arrived in.
     *
     * A host does not have to put its frames in order before it sends them. A
     * repeat, a pair that crossed in flight and one that arrives after the order
     * ended are ordinary traffic, and the fold is what says what each of them
     * does.
     */
    settle() {
        if (this.waiting.length === 0)
            return [];
        const frames = this.waiting;
        this.waiting = [];
        const outcomes = [];
        for (const frame of frames) {
            const row = this.byIntent.get(frame.intentId);
            if (row === undefined) {
                // Step 1. It is not an order this strategy placed. Refused and
                // recorded, and nothing is folded.
                outcomes.push({
                    intentId: frame.intentId,
                    refused: 'unknownIntent',
                    changed: false,
                    delta: 0,
                    price: null,
                    afterTerminal: false,
                });
                continue;
            }
            const outcome = foldFrame(row, frame);
            // Step 6, and the reason the row carries a position reference: the fill
            // settles the position that order belongs to and not whichever position
            // the leg holds now.
            if (outcome.delta > 0 && outcome.price !== null) {
                const units = row.side === 'buy' ? outcome.delta : -outcome.delta;
                this.positions.settle(row.positionRef, units, outcome.price);
            }
            outcomes.push(outcome);
        }
        return outcomes;
    }
    /** The leg's net position in units, `0` while flat. */
    size() {
        return this.positions.size();
    }
    /** The average price of the open position, absent while flat. */
    avgPrice() {
        return this.positions.avgPrice();
    }
    /** Every row, oldest first, for a host that reports what the run did. */
    rows() {
        return this.placed;
    }
    append(intent, order, bar, reduces) {
        const row = {
            intentId: intent.intentId,
            orderRef: '',
            tag: intent.tag,
            // The only leg has no name of its own: a name comes from a leg
            // declaration, and those are planned (`stdlib.md` 17.6).
            leg: '',
            positionRef: intent.positionRef,
            instrument: intent.instrument,
            product: intent.product,
            side: order.side,
            qty: order.qty,
            type: order.type,
            price: intent.limit,
            trigger: intent.trigger,
            status: 'placed',
            filledQty: 0,
            avgFillPrice: null,
            rejection: '',
            placedAt: bar.time,
            updatedAt: bar.time,
            reduces,
            // What this order puts into its position, in units, where the engine can
            // read it. `qtyType` is the unit `qty` is counted in and is per order
            // rather than per run, so a quantity the engine worked out is readable
            // in a declaration whose own unit is not (`host-interface.md` 7.1).
            units: intent.qtyType === 'units' ? order.qty : null,
        };
        this.placed.push(row);
        this.byIntent.set(row.intentId, row);
    }
    contextFor(bar) {
        return {
            instrument: this.options.instrument,
            product: this.options.product,
            qtyType: this.options.qtyType,
            declaredQty: this.options.declaredQty,
            tickSize: this.options.tickSize,
            pyramiding: this.options.pyramiding,
            bar,
            size: () => this.positions.size(),
            sizeOf: (ref) => this.positions.sizeOf(ref),
            avgPrice: () => this.positions.avgPrice(),
            mint: () => this.positions.mint(),
            rows: () => this.placed,
        };
    }
}
//# sourceMappingURL=ledger.js.map