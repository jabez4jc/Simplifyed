import { diagnosticIn } from './record.js';
/**
 * The bars, in order, with the venue answering between them.
 *
 * The one ordering rule: deliver, then append, then collect what the append
 * reported, then ask the venue what this bar did. A driver that asked the venue
 * before appending would price a fill against a bar the strategy had not seen.
 */
export function walk(engine, destination, bars, covered, keep) {
    const fills = [];
    const rows = [];
    const log = [];
    const frames = [];
    const diagnostics = [];
    const intents = new Map();
    const refs = new Map();
    const sizes = new Map();
    let pending = [];
    let seq = 0;
    // The bars are a settled history, so the fold is handed all of them before
    // bar 0 as `Engine.run` hands them. A `"lookahead"` read is the one reading
    // that can tell (`compiled-program.md` 2.16.2): over history it reads the
    // bucket a bar is inside in full, and a driver that fed the fold one bar at
    // a time would answer the bucket so far, which is the live chart's reading.
    const handed = bars.slice(0, covered.total).map(hostBarOf);
    engine.history(handed);
    for (let index = 0; index < covered.total; index += 1) {
        const bar = bars[index];
        const held = handed[index];
        if (bar === undefined || held === undefined)
            continue;
        for (const one of pending) {
            const ref = one.frame.orderRef;
            if (typeof ref === 'string')
                refs.set(one.frame.intentId, ref);
            engine.deliver(one.frame);
            frames.push(one);
        }
        pending = [];
        const result = engine.append(held, { isConfirmed: true, isRealtime: false }, covered.total);
        for (const intent of intentsIn(result))
            intents.set(intent.intentId, intent);
        seq = settle(result, index, bar, { intents, refs, sizes }, fills, seq);
        if (result.diagnostic !== undefined) {
            diagnostics.push(diagnosticIn(result.diagnostic, index));
            break;
        }
        if (keep.rows === true)
            rows.push([...result.columns]);
        if (keep.log === true) {
            for (const one of result.effects) {
                if (one.effect === 'log')
                    log.push({ barIndex: index, time: bar.time, value: one.args[0] ?? null });
            }
        }
        pending = destination.answers(index);
    }
    return { fills, frames, diagnostics, rows, log };
}
/** A recorded bar as the engine is handed one. */
function hostBarOf(bar) {
    return {
        time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close,
        volume: bar.volume, oi: bar.oi,
    };
}
/**
 * The fills one bar's fold settled.
 *
 * **The position sizes either side of step 6 are kept here and not read back
 * from the engine**, because the engine reports a leg's net and a fill settles
 * against one position reference: the two are different numbers whenever a leg
 * holds more than one position, which is every flip. They are folded in the
 * order the frames were folded in, from the same deltas, so they are the same
 * arithmetic the position book did rather than a second reading of its result.
 * When `FrameOutcome` carries them, these two lines come from the engine and
 * this fold keeps only the sequence number.
 *
 * A refused frame settles nothing and is not a fill. Today the fold reports the
 * refusal as a word rather than a code, so nothing here can write it into the
 * record as a diagnostic; that is OS7018 and OS7019, and both are deferred.
 */
function settle(result, index, bar, books, fills, from) {
    let seq = from;
    for (const outcome of result.frames) {
        if (outcome.refused !== undefined)
            continue;
        if (outcome.delta <= 0 || outcome.price === null)
            continue;
        const intent = books.intents.get(outcome.intentId);
        if (intent === undefined || intent.side === null)
            continue;
        const before = books.sizes.get(intent.positionRef) ?? 0;
        const after = before + (intent.side === 'sell' ? -outcome.delta : outcome.delta);
        books.sizes.set(intent.positionRef, after);
        seq += 1;
        fills.push({
            seq,
            intentId: outcome.intentId,
            orderRef: books.refs.get(outcome.intentId) ?? '',
            tag: intent.tag,
            positionRef: intent.positionRef,
            side: intent.side,
            units: outcome.delta,
            price: outcome.price,
            // The bar the fold happened at, which is the bar the position exists
            // from. Where the fill itself traded is the bar before it or this bar's
            // own open, and neither is a bar the strategy could have acted on it in.
            barIndex: index,
            barTime: bar.time,
            refSizeBefore: before,
            refSizeAfter: after,
        });
    }
    return seq;
}
/** Every intent one bar handed over, in the order the bar applied them. */
function intentsIn(result) {
    const out = [];
    for (const effect of result.effects)
        for (const intent of effect.intents)
            out.push(intent);
    return out;
}
//# sourceMappingURL=walk.js.map