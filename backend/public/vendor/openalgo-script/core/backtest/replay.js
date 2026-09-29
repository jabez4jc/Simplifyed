/**
 * A stored run, reported again and run again.
 *
 * Two questions, and they are different questions, which is why they are two
 * calls:
 *
 * - **`replay` asks whether the report is a function of the fills.** It folds
 *   the money again from the record's own fills and its own bar closes, with no
 *   bar executed and no order placed, and what comes back has to equal the
 *   report the record carries. If it does not, the report was reading something
 *   the engine happened to be holding rather than what the run settled, and
 *   nobody could reproduce it from the document.
 * - **`rerun` asks whether the engine still does what it did.** It executes the
 *   record's program over the record's bars under the record's settings, and
 *   the two records are compared as bytes. A rerun of one record on this engine
 *   is bit-identical or it is a defect: the tolerance on the record is for a
 *   second implementation and is never this one's excuse.
 *
 * **The bars are proved before either is attempted.** A record names the bars it
 * was made from by a hash, and bars are revised: a feed corrects a print, a
 * session is extended, a split is applied to history. A replay over revised bars
 * reporting the original figures is the most convincing wrong answer this system
 * can produce, so a set that does not hash to the record's is OS6022.
 *
 * **One engine call is made, and nothing is executed by it.** A declaration
 * field may be written by an `input()`, and what an input resolved to is the
 * engine's rule; asking it here rather than resolving a second time is what
 * keeps the replayed capital and commission the ones the run used. No bar is
 * appended, so no value is computed and no order is placed: the load is a
 * question about the program, not a run of it.
 */
import { reportOf, scheduleFromDeclaration } from '../accounting/index.js';
import { diagnosticFor } from '../diagnostics/index.js';
import { load } from '../engine/index.js';
import { backtest } from './drive.js';
import { declarationOf } from './declaration.js';
import { marksFor, windowFor } from './range.js';
import { barsHash } from './record.js';
/**
 * The record's own report, computed again from its own fills.
 *
 * The bars are the record's where it carries them and the caller's where it
 * points at them, and either way they are hashed against what the record names
 * before a figure is computed from them.
 */
export function replay(record, bars = null) {
    const held = barsOf(record, bars);
    if (!held.ok)
        return { ok: false, diagnostic: held.diagnostic };
    const framed = windowFor(held.bars, record.settings.range);
    if (!framed.ok)
        return { ok: false, diagnostic: framed.diagnostic };
    const declared = declarationIn(record);
    if (!declared.ok)
        return { ok: false, diagnostic: declared.diagnostic };
    return {
        ok: true,
        report: reportOf(record.fills, marksFor(held.bars, framed.covered), scheduleIn(record, declared.declaration), record.settings.contract, declared.declaration.capital),
    };
}
/**
 * The same run, executed again.
 *
 * Everything the run depended on is in the record: the program, the bars, the
 * settings and the inputs. So a rerun takes no argument the record does not
 * already hold, except the bars a referenced record points at rather than
 * carries, and the record it produces is comparable with the original field for
 * field and byte for byte.
 */
export function rerun(record, bars = null) {
    const held = barsOf(record, bars);
    if (!held.ok)
        return { ok: false, diagnostic: held.diagnostic };
    // Everything the run depended on, and that includes the two channels that
    // arrived after the sentence above was written. The instrument record is what
    // the engine read at load, so a rerun handed the contract alone runs under
    // different session facts and does not reproduce the bytes; the text is what
    // makes the rerun's record harvestable, and dropping it would turn a record
    // that could become a case into one that cannot, by being rerun.
    return backtest(record.program, held.bars, record.settings, {
        form: record.bars.form,
        ...(record.instrument === null ? {} : { instrument: record.instrument }),
        ...(record.sourceText === null ? {} : { sourceText: record.sourceText }),
    });
}
/**
 * The bars a record was made from, proved to be those bars.
 *
 * A record carrying its own bars is still checked against any that are supplied
 * beside them, because supplying a different set is exactly the mistake worth
 * catching: the caller believes they are replaying this run and they are
 * studying another one.
 */
export function barsOf(record, supplied) {
    if (supplied !== null) {
        const hash = barsHash(supplied);
        if (hash !== record.bars.hash)
            return { ok: false, diagnostic: mismatch(hash, record) };
        return { ok: true, bars: supplied };
    }
    if (record.bars.form === 'inline')
        return { ok: true, bars: record.bars.rows };
    // A referenced record points at bars it does not hold, so there is nothing to
    // replay until whoever holds them supplies them. It is the same refusal as a
    // wrong set, because the question it answers is the same one: are these the
    // bars the record was made from.
    return { ok: false, diagnostic: mismatch('no bars supplied', record) };
}
function mismatch(found, record) {
    return diagnosticFor('OS6022', NO_POSITION, { found, expected: record.bars.hash });
}
/**
 * What the record's own program declares, after the record's own inputs.
 *
 * The destination handed to the load is one that answers nothing, because
 * nothing is placed: a strategy declares the orders capability and a host that
 * did not offer it would be refused at load for a reason that has nothing to do
 * with the record.
 */
function declarationIn(record) {
    const loaded = load(record.program, {
        settings: record.settings.inputs,
        host: { route: () => undefined },
    });
    if (!loaded.ok)
        return { ok: false, diagnostic: loaded.diagnostic };
    return { ok: true, declaration: declarationOf(loaded.engine.program, loaded.inputs) };
}
/** The cost model the record was carried out under, derived where it was derived. */
function scheduleIn(record, declared) {
    if (record.settings.costs !== null)
        return record.settings.costs;
    return scheduleFromDeclaration(declared.commission, declared.commissionType, declared.slippage, record.settings.contract.currency, record.settings.contract.digits);
}
/** Where a refusal about a record points: nowhere in anybody's script. */
const NO_POSITION = { offset: 0, length: 0, line: 0, column: 0 };
//# sourceMappingURL=replay.js.map