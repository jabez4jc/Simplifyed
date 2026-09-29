/**
 * A run record, turned into the files a conformance case is made of.
 *
 * **The suite is harvested rather than written.** A case invented by hand tests
 * what somebody imagined a run does; a case taken from a run tests what a run
 * actually did. `conformance.md` section 2 says a case is one directory of named
 * files, and a record already holds every one of them: the script it ran, the
 * bars it ran over, the settings it ran with, and what came back. So this is a
 * projection and not a computation. Nothing here folds money, re-reads a report
 * or decides anything a run did not already decide.
 *
 * **Text out, and no I/O.** Core writes no files, so this returns the bytes and
 * the caller puts them where it likes. That also makes it testable without a
 * disk and usable from a browser, which is where most runs happen.
 *
 * **What it refuses, it refuses loudly.** A case with a missing file is worse
 * than no case: it fails on somebody else's engine and the blame lands on them.
 * So a record that cannot make a whole case does not make a partial one, and a
 * record that cannot make a faithful file does not guess at one: the script it
 * has no text for and the instrument fact its host never stated are both
 * refusals, never a hole and never a default.
 *
 * **Every setting of the run has a place in the case, and the table below says
 * which.** A run once harvested to a case that said nothing about the digit
 * count its money was rounded to, the charge schedule its host supplied or the
 * window its report was about, so a second engine ran under other values and
 * took the blame. `CARRIED` names the file each field of the settings is
 * carried in, the type refuses to compile when the settings gain a field with
 * no row, and a record whose settings hold a field the table does not know is
 * refused by name rather than written into a case that ran under something it
 * does not state.
 */
import { diagnosticFor } from '../diagnostics/index.js';
import { canonicalNumber, canonicalise } from '../emit/index.js';
/**
 * The channels a strategy run can be held to.
 *
 * Only what the record carries folded, and only what another engine could
 * produce independently. A case asserts the channels it names and no others, so
 * a change to drawing output cannot break a case about money.
 */
const STRATEGY_ASSERTS = ['diagnostics', 'orders', 'trades', 'performance'];
/**
 * `conformance.md` section 6: the loosest bounds a conformance case may declare.
 *
 * Core reads no page, so the two figures are written here, and
 * `tests/backtest/case-settings.test.ts` reads them out of section 6 and holds
 * these to the page, which is the arrangement `stdlib.md` section 20's figures
 * are under. Past either bound a run may still be a useful comparison; what it
 * is not is a case, so the projection makes no file of it.
 */
export const TOLERANCE_CAP = {
    rel: 1e-9,
    abs: 1e-12,
};
/**
 * Where each setting of a run is carried in a case, sections 2 and 3.
 *
 * Every field of the settings has a row and the type makes a field without one
 * a compile error, so a setting the record gains cannot be left out of a case
 * by forgetting. `fill` is the simulated destination's policy, and what it
 * decided is the frames, which are input: an engine handed `frames.csv` folds
 * them and fills nothing itself.
 */
const CARRIED = {
    contract: 'instrument.json, and backtest.json for the digit count',
    costs: 'backtest.json',
    range: 'backtest.json',
    inputs: 'settings.json',
    now: 'case.json',
    tolerance: 'case.json',
    fill: 'frames.csv, as the frames it decided',
};
/**
 * Where a refusal about a setting points: nowhere in the script.
 *
 * A run setting is what the host stated before the first bar, and a caret
 * under a line of the strategy would blame the one party that did not choose
 * it. The run's own settings check states the same position for the same reason.
 */
const NO_POSITION = { offset: 0, length: 0, line: 0, column: 0 };
/**
 * The files for one case, or the reason there are none.
 *
 * `now` is written only when the run pinned one. A case that names it when the
 * script never asked pins a clock the run did not depend on, and the next
 * reader has to work out whether it mattered.
 */
export function caseFilesFrom(record, identity) {
    if (record.sourceText === null) {
        return refused('the record carries no source text, so the case would have no script.os: ' +
            'record it with sourceText, or re-run the script to record one that has it');
    }
    if (record.bars.form !== 'inline') {
        return refused('the record points at its bars instead of holding them, and a case holds every ' +
            'byte of its own input: record it with form "inline"');
    }
    if (identity.id.trim() === '')
        return refused('a case needs an id');
    if (identity.description.trim() === '') {
        return refused('a case needs a one-sentence description, which is its failure message');
    }
    const instrument = instrumentOf(record);
    if (!instrument.ok)
        return instrument;
    const settings = settingsRefusal(record.settings);
    if (settings !== null)
        return settings;
    const files = {
        'case.json': json({
            id: identity.id,
            category: identity.category ?? 'strategy',
            profile: 'strategy',
            languageVersion: Number(record.languageVersion),
            description: identity.description,
            asserts: [...STRATEGY_ASSERTS],
            ...(record.settings.now === null ? {} : { now: record.settings.now }),
            tolerance: record.settings.tolerance,
        }),
        'script.os': endsWithNewline(record.sourceText),
        'bars.csv': barsCsv(record.bars.rows),
        // `conformance.md` section 4: performance is a list of one flat object
        // holding the summary statistics and nothing nested. The trades are their
        // own channel and are not repeated inside it, because a figure stated
        // twice in one case is a figure that can disagree with itself. The equity
        // curve, the monthly table and the markers are not written at all: the
        // first two are not conformance channels, being derived from fills and
        // closes the case already fixes, and a marker is a chart output the
        // `markers` channel owns, which a case about money does not assert.
        'expected.json': json({
            diagnostics: record.diagnostics,
            orders: record.orders,
            trades: record.report.trades,
            performance: [record.report.summary],
        }),
        // Section 2: the record of `host-interface.md` 4.1, which is what the
        // engine was handed and not the money layer's contract. The suite's
        // defaults for an absent file are boring on purpose and are not this run's
        // instrument, so the file is always written.
        'instrument.json': json(instrument.value),
        // Section 3: what the report was folded under and the script never states.
        // Always written, because every run rounds money to some digit count, and a
        // strategy case that left it out would be run under whatever count a runner
        // assumed. `costs` is null for the declaration's own schedule and `range`
        // carries null for a bound nobody stated, so the file says what the run ran
        // under in every case rather than leaving a default to a runner.
        'backtest.json': json({
            digits: record.settings.contract.digits,
            costs: record.settings.costs,
            range: record.settings.range,
        }),
    };
    // Without this the case is unpassable, on every engine including the one that
    // wrote it. `conformance.md` section 3 ends "a case with no `frames.csv` is
    // handed no frames at all", and what `expected.json` asserts through the
    // orders channel is what came of the frames: a status, a cumulative quantity,
    // an average fill price. An engine handed none of them folds nothing and
    // disagrees with every row, and the failure reads as a defect in that engine.
    //
    // Written only when the run had frames, because an empty file and an absent
    // one mean the same thing here and the absent one says it in fewer bytes.
    if (record.frames.length > 0)
        files['frames.csv'] = framesCsv(record.frames);
    // Written only when the run had inputs to write. An empty settings.json says
    // "these are the values" about nothing, and section 2 reads an absent one as
    // every input taking its declared default, which is what actually happened.
    if (Object.keys(record.settings.inputs).length > 0) {
        files['settings.json'] = json(record.settings.inputs);
    }
    return { ok: true, files };
}
/** A refusal about what the record holds, which no catalogue entry is about. */
function refused(reason) {
    return { ok: false, reason, code: null };
}
/**
 * The instrument record a case can state faithfully, or why there is none.
 *
 * Two refusals, and both are the same refusal: the file `conformance.md`
 * section 2 names is the record of `host-interface.md` 4.1, and a record that
 * cannot produce that record cannot produce the file.
 *
 * A record written before version 3 carries none, because the facts beside
 * the contract were handed to the engine and written down nowhere. And 4.1
 * requires one fact of every host, `hasVolume`, which is the one the engine
 * does not refuse a run without: a run whose host never stated it ran with the
 * flag absent, so a file stating it would hand a second engine a different
 * study than the one the expected output came from, and a file omitting it is
 * not a 4.1 record. The other rules that page states about a record, a session
 * with no timezone to read it in, are refused at load, so a run that happened
 * cannot carry one.
 */
function instrumentOf(record) {
    if (record.instrument === null) {
        return refused('the record carries no instrument record, so the case would have no instrument.json: ' +
            'it was written before record version 3, and re-running the script records one');
    }
    if (typeof record.instrument.hasVolume !== 'boolean') {
        return refused('the run was handed no hasVolume, which host-interface.md 4.1 requires of every ' +
            'host, so instrument.json cannot be the record that page defines: run the script ' +
            'with the instrument facts stated');
    }
    return { ok: true, value: record.instrument };
}
/**
 * Whether every setting the run was carried out under has a place in the case,
 * and whether its tolerance is one the suite accepts.
 *
 * The first question is asked of the record rather than of the type, because a
 * record read back from JSON is whatever was written: a field this projection
 * has no file for is refused with its name, never passed over into a case that
 * then ran under a value it does not state.
 */
function settingsRefusal(settings) {
    for (const key of Object.keys(settings)) {
        if (key in CARRIED)
            continue;
        return refused(`the record's settings carry ${key}, which no file of conformance.md section 2 has a ` +
            'place for, so a case written from it would run under a setting it does not state: ' +
            'give the setting a file on that page and a row in this projection first');
    }
    return toleranceRefusal(settings.tolerance);
}
/**
 * A tolerance past the cap is a comparison somebody may find useful and is not
 * a case, `conformance.md` section 6.
 *
 * Refused here, where the case is written, and not only where one is read,
 * because a directory the suite will not accept fails every runner it meets
 * and the blame lands on the engine under test. The run's own settings check
 * refuses a bound with no reason and a bound below zero before a record
 * exists; the cap is the one rule about a tolerance that is the suite's rather
 * than the run's, so it is the one asked here.
 */
function toleranceRefusal(tolerance) {
    const { abs, rel } = tolerance;
    if (!Number.isFinite(abs) || !Number.isFinite(rel)) {
        return settingRefusal('a bound is not a finite number');
    }
    if (abs <= TOLERANCE_CAP.abs && rel <= TOLERANCE_CAP.rel)
        return null;
    return settingRefusal(`a bound of ${canonicalNumber(abs)} absolute and ${canonicalNumber(rel)} relative is ` +
        'past the cap conformance.md section 6 puts on a conformance case, ' +
        `${canonicalNumber(TOLERANCE_CAP.abs)} absolute and ${canonicalNumber(TOLERANCE_CAP.rel)} ` +
        'relative, so this run is a comparison and not a case');
}
/** A refusal about the comparison tolerance, filed under the run's own code for a setting. */
function settingRefusal(problem) {
    const diagnostic = diagnosticFor('OS6021', NO_POSITION, {
        setting: 'The comparison tolerance',
        problem,
    });
    return { ok: false, reason: diagnostic.message, code: diagnostic.code };
}
/**
 * Through the canonical writer, so a case's bytes are the record's bytes.
 *
 * There is one canonical writer in this repository and this is not a second
 * one: key order and number form are fixed for everybody, which is what lets a
 * case be compared as text at all.
 */
function json(value) {
    return `${canonicalise(value)}\n`;
}
/** `conformance.md` section 3: header, one row per bar, oldest first, `none` for absent. */
function barsCsv(rows) {
    const lines = ['time,open,high,low,close,volume'];
    for (const bar of rows) {
        lines.push([bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume].map(cell).join(','));
    }
    return `${lines.join('\n')}\n`;
}
/**
 * `conformance.md` section 3: the fields of a frame, in the order that page names.
 *
 * A projection and not a translation. The record already holds an intent as an
 * ordinal rather than as this engine's own id, for the reason the same section
 * gives: a case cannot know the id another engine minted and must not depend on
 * its spelling.
 *
 * The instant is written on every row, `none` where the destination stated
 * none, through the same cell writer as an absent price. A case whose frames
 * carried instants and whose file did not would assert an `updatedAt` that its
 * own input cannot reproduce, which is what the column closes.
 */
function framesCsv(frames) {
    const lines = ['afterBar,intent,status,filledQty,avgFillPrice,orderRef,text,time'];
    for (const frame of frames) {
        lines.push([
            canonicalNumber(frame.afterBar),
            canonicalNumber(frame.intent),
            frame.status,
            canonicalNumber(frame.filledQty),
            cell(frame.avgFillPrice),
            frame.orderRef ?? '',
            frame.text ?? '',
            cell(frame.time),
        ].join(','));
    }
    return `${lines.join('\n')}\n`;
}
/**
 * One cell, through the one number writer.
 *
 * An absent field is `none` rather than empty, because an empty cell between two
 * commas is indistinguishable from a file somebody's editor trimmed, and a
 * language whose central idea is the absent value cannot be vague about it. A
 * case is compared as text, so the number is written by the rule of
 * `language.md` 5.5 and by the same function that writes every other number in
 * the repository, never by a second spelling that agrees until it does not.
 */
function cell(value) {
    return value === null || !Number.isFinite(value) ? 'none' : canonicalNumber(value);
}
/** A text file ends with a newline, so appending to it never joins two lines. */
function endsWithNewline(text) {
    return text.endsWith('\n') ? text : `${text}\n`;
}
//# sourceMappingURL=case.js.map