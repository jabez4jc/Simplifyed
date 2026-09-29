import { canonicalNumber, canonicalise, programHash, sha256, sourceHash } from '../emit/index.js';
import { VERSION } from '../version/index.js';
/**
 * The revision of this document's own shape.
 *
 * A reader is handed a record and has to know what it is looking at before it
 * reads a field, so the number is first in the document and is written by this
 * file alone. It moves when a channel is added or a meaning changes, never when
 * a figure in a report does.
 */
export const RECORD_VERSION = 4;
/**
 * The revision each later channel arrived in.
 *
 * A record written before a channel existed reads with that channel absent,
 * and this table is what `recordFromJson` reads it from: one row per channel
 * added since version 1, so the rule for an old record is stated once and
 * grows by a line when the next channel does.
 *
 * `frameTime` is a field of a row rather than a channel of the document, and it
 * is a row here for the same reason the other two are: what a reader has to
 * know is which revision it arrived in. Where the absence is written differs,
 * and that is the reader's business below, not this table's.
 */
const ADDED_IN = { sourceText: 2, instrument: 3, frameTime: 4 };
/** What this engine calls itself in a record it wrote. */
const ENGINE_NAME = 'openscript';
/**
 * One run, as the document another engine is handed.
 *
 * Nothing is computed here. Every channel arrives folded, because what a record
 * says has to be what the run did rather than what a second fold of the same
 * inputs came to: a record that recomputed its own report would agree with
 * itself whatever the engine had actually done.
 */
export function recordOf(parts) {
    return {
        recordVersion: RECORD_VERSION,
        engine: { name: ENGINE_NAME, version: VERSION },
        languageVersion: canonicalNumber(parts.program.openscript.language),
        program: parts.program,
        programHash: programHash(parts.program),
        source: parts.program.source,
        sourceText: textFor(parts),
        settings: parts.settings,
        instrument: parts.instrument,
        bars: barsIn(parts.bars, parts.form),
        frames: parts.frames,
        fills: parts.fills,
        orders: parts.orders,
        diagnostics: parts.diagnostics,
        report: parts.report,
    };
}
/**
 * The source text, checked against the hash the program already carries.
 *
 * A check rather than a promise, and it costs one hash of a few kilobytes. The
 * failure it exists for is quiet: a caller that passes the text of a different
 * revision than the one it compiled produces a case whose script does not make
 * its own expected output, and the engine being tested gets the blame for a
 * disagreement that was in the case all along.
 */
function textFor(parts) {
    const text = parts.sourceText;
    if (text === undefined)
        return null;
    if (sourceHash(text) !== parts.program.source.hash) {
        throw new Error('openscript: the source text does not hash to the source hash the program carries');
    }
    return text;
}
/**
 * The bars, held or pointed at, and the same hash either way.
 *
 * The referenced form keeps the first and last times so that a reader can say
 * which bars are wanted without holding them, and the count so that a set of
 * the wrong length is known to be wrong before it is hashed.
 */
export function barsIn(bars, form) {
    const hash = barsHash(bars);
    if (form === 'inline') {
        return { form: 'inline', hash, count: bars.length, rows: bars };
    }
    return {
        form: 'referenced',
        hash,
        count: bars.length,
        firstTime: bars[0]?.time ?? null,
        lastTime: bars[bars.length - 1]?.time ?? null,
    };
}
/**
 * The hash a record names its bars by.
 *
 * Over the canonical tuple of each bar, in the order they were supplied, and
 * through the canonical encoding the compiled program is hashed with, so there
 * is one canonical writer in the repository rather than two that agree until
 * one of them is changed. A tuple rather than an object, because the field
 * order is then the specification's and not a sort's.
 */
export function barsHash(bars) {
    const tuples = bars.map((bar) => [
        bar.time,
        bar.open,
        bar.high,
        bar.low,
        bar.close,
        bar.volume,
        bar.oi,
    ]);
    return 'sha256:' + sha256(canonicalise(tuples));
}
/**
 * The record as the bytes another engine reads.
 *
 * Through the canonical encoding, so key order is fixed, every number is in the
 * shortest decimal form that reads back as itself, and two runs of the same
 * record produce the same bytes on every machine. That is what makes the
 * reproducibility test a byte comparison rather than a tour of the fields.
 */
export function recordToJson(record) {
    return canonicalise(record);
}
/**
 * The run, without who produced it.
 *
 * **`engine` is provenance, and provenance is not part of the run.** The claim
 * a rerun makes is that the run is a function of the record, and that claim has
 * to survive the engine it runs on being upgraded: a record stored under
 * `0.3.0` and rerun under `0.4.0` produces the same trades, the same fills and
 * the same money, and a document carrying the version stamp inside the bytes
 * being compared says it does not.
 *
 * It was compared as whole bytes until the first version bump would have broken
 * it, which is a test that passes for exactly as long as nothing changes and
 * then fails for the one reason that is not a defect. So the stamp stays in the
 * record, because knowing which engine wrote a run is worth keeping, and the
 * comparison is made over everything else.
 */
export function runBytes(record) {
    const { engine: _engine, ...run } = record;
    return canonicalise(run);
}
/**
 * A record read back from those bytes.
 *
 * A parse and not a validation: what comes back is the document as it was
 * written, and a document this engine did not write is the caller's to trust or
 * not. The one thing asserted is the revision, because reading a later
 * revision's fields under this one's rules is how a record silently becomes a
 * different run.
 */
export function recordFromJson(text) {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object')
        return null;
    const record = parsed;
    const version = record.recordVersion;
    if (typeof version !== 'number' || version < 1 || version > RECORD_VERSION)
        return null;
    // An earlier revision is readable and a later one is not, and the asymmetry
    // is the point. A later revision may mean something by a field this one
    // thinks it knows, which is how a record silently becomes a different run. An
    // earlier one only ever has fewer: every channel it carries means here what
    // it meant there, and the ones added since are absent rather than wrong. So a
    // run stored months ago still reads, which is the whole of what it was stored
    // for, and a channel it never carried reads as absent.
    if (version === RECORD_VERSION)
        return record;
    return {
        ...record,
        sourceText: version >= ADDED_IN.sourceText ? record.sourceText : null,
        instrument: version >= ADDED_IN.instrument ? record.instrument : null,
        frames: version >= ADDED_IN.frameTime ? record.frames : timeless(record.frames),
    };
}
/**
 * The frames of a record written before a frame carried an instant.
 *
 * The absence is written on every frame rather than on the record, because the
 * channel is a field of a row: a reader that left the field undefined would
 * hand the case projection an undefined where the column's absent spelling
 * belongs, and the file would read `undefined` back to the next engine. The
 * frames are left as they are when they are not an array, because this is a
 * parse and not a validation and a document this engine did not write is the
 * caller's to trust or not.
 */
function timeless(frames) {
    if (!Array.isArray(frames))
        return frames;
    return frames.map((frame) => ({ ...frame, time: null }));
}
/**
 * One ledger row, flattened into the words a case file prints.
 *
 * The engine's own types do not cross: a second engine has its own, and a
 * channel written in this one's would be a case only this one could read. The
 * intent is an ordinal for the same reason, because no engine can know what id
 * another minted.
 *
 * `qtyType` comes from the intent rather than from the row, because the unit a
 * quantity is counted in is per order and not per leg: an order the engine
 * sized itself is in units whatever the declaration counts in, and a row that
 * printed the declaration's unit for it would state a quantity in a unit it was
 * never measured in.
 */
export function orderIn(row, intent, qtyType) {
    return {
        intent,
        orderRef: row.orderRef,
        tag: row.tag,
        leg: row.leg,
        positionRef: row.positionRef,
        symbol: row.instrument.symbol,
        exchange: row.instrument.exchange,
        product: row.product,
        side: row.side,
        qty: row.qty,
        qtyType,
        type: row.type,
        price: row.price,
        trigger: row.trigger,
        status: row.status,
        filledQty: row.filledQty,
        avgFillPrice: row.avgFillPrice,
        rejection: row.rejection === '' ? null : row.rejection,
        placedAt: row.placedAt,
        updatedAt: row.updatedAt,
        units: row.units,
    };
}
/** One diagnostic, as a record holds it: the code, the span and the bar. */
export function diagnosticIn(diagnostic, barIndex) {
    return {
        code: diagnostic.code,
        line: diagnostic.span.line,
        column: diagnostic.span.column,
        severity: diagnostic.severity,
        barIndex,
    };
}
//# sourceMappingURL=record.js.map