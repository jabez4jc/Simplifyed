const STATUSES = [
    'placed',
    'working',
    'triggerPending',
    'filled',
    'cancelled',
    'rejected',
    'expired',
];
/**
 * Which words end an order.
 *
 * A terminal row still takes a fill, under 17.8, so this decides what the
 * status may become and nothing about what the quantity may do.
 */
const TERMINAL = new Set([
    'filled',
    'cancelled',
    'rejected',
    'expired',
]);
/**
 * How far along its life a status sits.
 *
 * Two words share the middle rank because an order that is live and one that is
 * waiting for its trigger are the same distance from the end, and either may
 * follow the other without going backwards.
 */
function rankOf(status) {
    if (status === 'placed')
        return 0;
    return TERMINAL.has(status) ? 2 : 1;
}
export function isTerminal(status) {
    return TERMINAL.has(status);
}
/** The word a host sent, or nothing when it is not one of the seven. */
export function statusFrom(word) {
    return STATUSES.find((one) => one === word);
}
/**
 * How much of this row's claim on the part it reduces is still outstanding.
 *
 * **An order that has been sent and not answered is the whole of what this
 * file exists to make visible.** A position is folded from settled fills and
 * from nothing else (17.8), so such an order has moved no position figure: the
 * leg still reads what it held before it was sent, and a second reducing order
 * measured against the leg alone sends the position a second time.
 *
 * Four facts decide the number, and each of them is a case a strategy meets:
 *
 * - **A partial fill of an order the engine counted.** Three sold with one
 *   filled leaves two working, because the one that filled has already moved
 *   the leg and only the other two are still to come.
 * - **A partial fill of one it could not count**, where the claim stands whole
 *   until the order ends. The claim is in units and the fill is in whatever
 *   the destination answered a quantity in lots, cash or an equity percent
 *   with, and subtracting one from the other is the drift this file is written
 *   to make impossible: a destination answering more than the claim released
 *   room that was never there and the next close sent the position again.
 * - **An order that has ended.** A rejection, a cancellation and an expiry all
 *   put the row at a terminal status, and nothing more is coming from any of
 *   them, so the claim is released and the strategy may close again. That is
 *   the script's way out of a destination that refused its close.
 * - **An order that adds**, which claims nothing and holds nothing: an entry
 *   that has not settled is not a position, and counting it would let a close
 *   be sent for units that may never exist.
 *
 * **This answers one question and one reader.** What is left to close is a
 * question about a part of the leg, and `closable.ts` is where it is asked.
 * Which side a position reference is on is a different question, asked of one
 * reference against what has settled on it, and `holdings.ts` reads the order's
 * own size for it rather than this.
 */
export function workingUnits(row) {
    const reduces = row.reduces;
    if (reduces === null || isTerminal(row.status))
        return 0;
    return reduces.counted ? Math.max(0, reduces.claimed - row.filledQty) : reduces.claimed;
}
function refuse(frame, why) {
    return {
        intentId: frame.intentId,
        refused: why,
        changed: false,
        delta: 0,
        price: null,
        afterTerminal: false,
    };
}
/**
 * Folds one frame into one row, `stdlib.md` 17.8 steps 2 to 5 and 7.
 *
 * Step 1 is the ledger's, because locating a row is a question about the whole
 * ledger rather than about any one row, and step 6 is the position book's: this
 * function says how many units settled and at what price, and where they settle
 * is `positions.ts`.
 */
export function foldFrame(row, frame) {
    // A word outside the vocabulary leaves the status alone and the rest of the
    // frame folds anyway. Mapping a destination's own words onto the vocabulary
    // is the host's job under 17.7, and an engine that guessed at one would
    // decide an order was dead on a word it had never seen. Refusing the whole
    // frame instead would throw away the cumulative quantity it carries, which is
    // real whatever the word beside it says, and losing a real fill is silent in
    // exactly the way decision 24 describes.
    const status = statusFrom(frame.status);
    const wasTerminal = isTerminal(row.status);
    // Step 2. The cumulative quantity never decreases, so a frame reporting less
    // than the row already holds contributes nothing.
    const filled = Math.max(row.filledQty, frame.filledQty);
    const delta = filled - row.filledQty;
    // Step 3. The destination computed its average over the cumulative quantity,
    // so the row takes that average whole. The engine never averages two averages
    // of its own.
    const price = frame.avgFillPrice ?? null;
    if (delta > 0 && price === null)
        return refuse(frame, 'fillWithNoPrice');
    // Step 4, which a frame arriving at a terminal row does not run: the status
    // records how the order ended and the quantity records what traded, and the
    // two are both true.
    const moved = status !== undefined &&
        status !== 'placed' &&
        !wasTerminal &&
        rankOf(status) >= rankOf(row.status) &&
        status !== row.status;
    const text = frame.text ?? '';
    const newText = text !== '' && text !== row.rejection;
    // Step 5.
    const changed = moved || delta > 0 || newText;
    // Step 7. A repeated frame and one overtaken by a later frame both end here,
    // having changed nothing: no fill, no event, no report row.
    if (!changed) {
        return {
            intentId: frame.intentId,
            refused: undefined,
            changed: false,
            delta: 0,
            price: null,
            afterTerminal: false,
        };
    }
    if (moved && status !== undefined)
        row.status = status;
    if (delta > 0) {
        row.filledQty = filled;
        row.avgFillPrice = price;
    }
    if (newText)
        row.rejection = text;
    if (typeof frame.orderRef === 'string')
        row.orderRef = frame.orderRef;
    if (frame.sentInstrument !== undefined && frame.sentInstrument !== null) {
        row.instrument = frame.sentInstrument;
    }
    if (typeof frame.sentProduct === 'string')
        row.product = frame.sentProduct;
    if (typeof frame.time === 'number')
        row.updatedAt = frame.time;
    return {
        intentId: frame.intentId,
        refused: undefined,
        changed: true,
        delta,
        price: delta > 0 ? price : null,
        afterTerminal: wasTerminal && delta > 0,
    };
}
//# sourceMappingURL=row.js.map