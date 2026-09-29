/**
 * An id no run mints, which a row naming no intent of this run is delivered
 * under.
 *
 * Ids are counted from one by the ledger that mints them, so nothing below one
 * can name a row and the fold refuses the frame by the rule it refuses every
 * other unknown one by. The alternative was an id of a real row chosen by some
 * rule of this file's own, which would fold a case's frame into whichever order
 * happened to be near it.
 */
const NO_INTENT = -1;
/**
 * A destination holding one case's frames, ready at the boundaries they name.
 *
 * Built before the run rather than during it, because the rows are input: what
 * a boundary hands over was decided by whoever wrote the case and not by
 * anything this run does. The one thing it learns as the run goes is which
 * intent an ordinal names, which only the run can say.
 */
export class Delivery {
    intents = [];
    /** The rows of each boundary, in file order, which section 3 fixes as the delivery order. */
    rows = new Map();
    constructor(frames) {
        for (const row of frames) {
            const at = this.rows.get(row.afterBar);
            if (at === undefined)
                this.rows.set(row.afterBar, [row]);
            else
                at.push(row);
        }
    }
    /** Nothing is decided by an order arriving here: it is counted, and that is all. */
    route(effect) {
        for (const intent of effect.intents)
            this.intents.push(intent);
    }
    answers(barIndex) {
        const due = this.rows.get(barIndex) ?? [];
        return due.map((row) => ({
            frame: frameOf(row, this.intents[row.intent - 1]),
            afterBar: barIndex,
            row,
        }));
    }
}
/** One row of a case, as the frame `host-interface.md` 7.2 describes. */
function frameOf(row, intent) {
    return {
        intentId: intent?.intentId ?? NO_INTENT,
        status: row.status,
        filledQty: row.filledQty,
        avgFillPrice: row.avgFillPrice,
        orderRef: row.orderRef,
        text: row.text,
        time: row.time,
    };
}
/**
 * The ordinal of every intent, which is how a case names one.
 *
 * One, two, three in the order the run placed them, because no engine can know
 * the id another minted and a case that named one would only ever be readable
 * by the engine that wrote it.
 */
export function ordinalsOf(intents) {
    const out = new Map();
    for (const intent of intents) {
        if (!out.has(intent.intentId))
            out.set(intent.intentId, out.size + 1);
    }
    return out;
}
/**
 * One delivered frame, in the columns a case file prints.
 *
 * The instant travels with it. `stdlib.md` 17.7 folds `updatedAt` from a
 * frame's `time`, so a driver that dropped the field here wrote a record whose
 * ledger no engine could fold from the record's own frames: it would have
 * nothing to move that field to and would leave it at `placedAt`.
 */
export function framedAs(frame, afterBar, ordinals) {
    return {
        afterBar,
        intent: ordinals.get(frame.intentId) ?? 0,
        status: frame.status,
        filledQty: frame.filledQty,
        avgFillPrice: frame.avgFillPrice ?? null,
        orderRef: frame.orderRef ?? null,
        text: frame.text ?? null,
        time: frame.time ?? null,
    };
}
//# sourceMappingURL=deliver.js.map