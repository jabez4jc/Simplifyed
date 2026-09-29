/**
 * Load-time verification, `compiled-program.md` 3.5, and the refusals a host
 * makes beside it.
 *
 * Before executing a single bar an engine must verify the program. What is
 * bought by doing it here rather than discovering a problem halfway through a
 * bar is stated in the specification and is the reason the interpreter is as
 * plain as it is: a verified program cannot underflow the stack, cannot jump
 * out of bounds, cannot address a slot that does not exist and cannot loop
 * without charging the budget. Every remaining failure is a script error with a
 * source position, which is the only kind of failure a user should ever see.
 *
 * Three refusals that are not verification sit here too, because they happen at
 * the same moment and for the same reason: a version this engine does not
 * implement (OS6016, OS6017), a capability it does not have (OS6006), and a
 * library entry that disagrees with its manifest (OS6004). Each names what it
 * refused, and none of them silently accepts a program it cannot run. The
 * fourth, the budgets a host is willing to spend, is `verify-budgets.ts`: it is
 * a question about this host rather than about this program, and two hosts may
 * honestly answer it differently.
 *
 * **The order of those refusals is the specification's, 9.4, and not an
 * accident of where the code grew.** It is an ordered list that stops at the
 * first failure, so a program that is wrong in two ways reports the one the
 * list reaches first, and two engines hand the same program the same message.
 * Each step below says which number it is.
 */
import { COMPILED_FORMAT_VERSION } from '../version/index.js';
import { NO_POSITION, failure } from './errors.js';
import { manifestEntry, manifestSays } from './library/index.js';
import { checkList, checkOnce } from './verify-code.js';
import { allCode, checkBudgets } from './verify-budgets.js';
import { ShapeCheck } from './verify-shape.js';
import { checkTables } from './verify-tables.js';
/** The language versions whose library semantics this engine implements. */
export const LANGUAGE_VERSIONS = [1];
/**
 * The format major this engine loads, and the only part of the format version a
 * refusal turns on.
 *
 * `COMPILED_FORMAT_VERSION` is the highest minor of that major this engine was
 * built against, which is what 9.1 asks an engine to declare: the majors it can
 * load, and the highest minor of each. 9.4 step 3 then says a higher minor
 * continues, and that line is the whole compatibility promise in one decision.
 *
 * A minor bump is additive by 9.2: it may add a field an engine that ignores it
 * still computes the same numbers from, and anything whose absence would change
 * a number must be announced by a tag in `requires`, which step 4 checks
 * immediately afterwards. So the tag is the real mechanism and the version is
 * the coarse one. An engine that refused a higher minor would refuse every
 * program in the world the day the format reached 1.1, including every program
 * it can run perfectly, and a minor bump would be a major one wearing a smaller
 * number. An older minor loads for the same reason from the other side: it
 * carries a subset of the fields this engine already reads.
 *
 * A major is a different format that happens to share a name (9.3), so a major
 * that is not this one, in either direction, is OS6016 and never a best effort.
 */
const ENGINE_FORMAT_MAJOR = majorOf(COMPILED_FORMAT_VERSION);
/** The leading number of a dotted version, or nothing when it is not one. */
function majorOf(version) {
    if (!/^\d+(\.\d+)*$/.test(version))
        return undefined;
    return Number(version.split('.')[0]);
}
/**
 * What this engine can do, as the tags of 2.2.
 *
 * Two tags are not here, and both for the same reason: they are the host's
 * rather than the engine's.
 *
 * `orders` is one. The engine turns an order call into a pending effect and
 * hands it to whatever route the host supplied, so the capability belongs to
 * the configuration, and `capabilitiesFor` adds it when a route exists.
 *
 * `req.symbol` is the other. A read of another instrument needs bars the engine
 * does not hold and cannot derive, so a host with no request provider cannot
 * serve one, and a program that makes one is refused at load with OS6006 naming
 * the tag rather than drawing a study with a silently empty line through it.
 * **`req.timeframe` is here unconditionally**, because a read of the chart's own
 * instrument at a coarser interval is folded from the bars the engine already
 * has (`host-interface.md` 5.1), so there is nothing for a host to supply and
 * nothing for it to decline.
 */
const ENGINE_CAPABILITIES = [
    'core.1',
    'arrays',
    'functions',
    'loops',
    'objects',
    'tables',
    'alerts',
    'req.timeframe',
];
export function capabilitiesFor(hasOrderRoute, hasRequestProvider = false) {
    const tags = [...ENGINE_CAPABILITIES];
    if (hasOrderRoute)
        tags.push('orders');
    if (hasRequestProvider)
        tags.push('req.symbol');
    return tags;
}
/** Which instruction needs which tag, the part of check 8 the program decides. */
const INSTRUCTION_TAGS = {
    ARRAY: 'arrays',
    ELEM: 'arrays',
    CALL_FN: 'functions',
    TICK: 'loops',
};
export function verify(raw, options) {
    const shape = new ShapeCheck();
    const refused = (diagnostic) => ({ ok: false, diagnostic });
    const broken = () => refused(shape.problem() ?? failure('OS6018', NO_POSITION, {
        location: 'the program',
        reason: 'it is not a compiled program',
    }));
    if (!shape.object(raw, 'the program'))
        return broken();
    const version = raw['openscript'];
    if (!shape.object(version, 'openscript'))
        return broken();
    if (!shape.string(version['format'], 'openscript.format'))
        return broken();
    if (!shape.whole(version['language'], 'openscript.language'))
        return broken();
    // Steps 2 and 3: the major decides, and a higher minor loads.
    const major = majorOf(version['format']);
    if (major === undefined) {
        shape.fail('openscript.format', 'a version of the form major.minor was required');
        return broken();
    }
    if (major !== ENGINE_FORMAT_MAJOR) {
        return refused(failure('OS6016', NO_POSITION, {
            found: version['format'],
            max: COMPILED_FORMAT_VERSION,
        }));
    }
    // Step 1's other half: the tables every later step indexes into.
    if (!checkTables(shape, raw))
        return broken();
    const program = raw;
    // Step 4, and it comes before the language version on purpose: a program that
    // is both compiled from a language this engine lacks and dependent on a
    // capability it lacks reports the capability, which names the feature that was
    // refused rather than a number the reader has to look up.
    for (const tag of program.requires) {
        if (!options.capabilities.includes(tag)) {
            return refused(failure('OS6006', NO_POSITION, { tag }));
        }
    }
    // Step 5.
    if (!LANGUAGE_VERSIONS.includes(program.openscript.language)) {
        return refused(failure('OS6017', NO_POSITION, {
            found: program.openscript.language,
            versions: LANGUAGE_VERSIONS.join(', '),
        }));
    }
    // Step 6.
    const library = checkLibrary(program);
    if (library !== undefined)
        return refused(library);
    // Step 7.
    const budget = checkBudgets(program, options.limits);
    if (budget !== undefined)
        return refused(budget);
    // Step 8, which is 3.5 itself.
    const sizes = tableSizes(program);
    if (!checkList(shape, 'code', program.code, sizes, 'HALT'))
        return broken();
    for (let f = 0; f < program.functions.length; f += 1) {
        const body = program.functions[f]?.code ?? [];
        if (!checkList(shape, `functions[${f}]`, body, bodySizes(sizes, program, f), 'RET')) {
            return broken();
        }
    }
    if (!checkOnce(shape, program.code, program.channels.map((one) => one.once)))
        return broken();
    // 2.16.1: a body is an instruction list the same machine walks, so it gets
    // the same walk. Its terminator is `RET` rather than `HALT`, because a body
    // produces a value and `HALT` does not.
    if (!checkBodies(shape, 'requests', program.requests, sizes))
        return broken();
    // Check 8, the program's half: an instruction whose tag it never declared.
    const missing = missingTag(program);
    if (missing !== undefined) {
        return refused(failure('OS6018', NO_POSITION, {
            location: 'requires',
            reason: `the program uses ${missing.opcode} and does not declare ${missing.tag}`,
        }));
    }
    return { ok: true, program };
}
/** Check 9: every `lib.functions` entry agrees with this engine's manifest. */
function checkLibrary(program) {
    for (let index = 0; index < program.lib.functions.length; index += 1) {
        const entry = program.lib.functions[index];
        if (entry === undefined)
            continue;
        const mine = manifestEntry(entry.name, entry.arity);
        if (mine === undefined) {
            return failure('OS6004', NO_POSITION, {
                index,
                name: entry.name,
                arity: entry.arity,
                manifest: manifestSays(entry.name),
            });
        }
        if (mine.state !== entry.state || mine.effect !== entry.effect) {
            return failure('OS6004', NO_POSITION, {
                index,
                name: entry.name,
                arity: entry.arity,
                manifest: `${entry.name} holding state ${String(mine.state)} with effect ${mine.effect}`,
            });
        }
    }
    return undefined;
}
/** Check 8's other half: an instruction whose tag the program did not declare. */
function missingTag(program) {
    for (const code of allCode(program)) {
        for (const instruction of code) {
            const tag = INSTRUCTION_TAGS[instruction[0]];
            if (tag !== undefined && !program.requires.includes(tag)) {
                return { opcode: instruction[0], tag };
            }
        }
    }
    return undefined;
}
/**
 * Check 8 over every read's body, and every read written inside one.
 *
 * The body's tables are its own and counted from zero, so the limits a walk is
 * given are rebuilt for each of them; `consts` and `lib.functions` stay the
 * program's, because those are the two the body shares (2.16.1). `channels` is
 * zero, which is what refuses an `EMIT` inside a body without a rule of its
 * own: a read carries no channel, no plot and no declaration.
 */
function checkBodies(shape, prefix, requests, outer) {
    for (let i = 0; i < requests.length; i += 1) {
        const body = requests[i]?.body;
        if (body === undefined)
            continue;
        const at = `${prefix}[${i}].body`;
        const sizes = {
            ...outer,
            slots: body.frame.slots,
            cells: body.cells.length,
            states: body.states.length,
            registers: body.series.length,
            channels: 0,
            callSites: body.callSites.length,
            loops: body.loops.length,
            series: 0,
            argcOf: (site) => body.callSites[site]?.argc ?? 0,
        };
        if (!checkList(shape, `${at}.code`, body.code, sizes, 'RET'))
            return false;
        for (let f = 0; f < body.functions.length; f += 1) {
            const fn = body.functions[f];
            if (fn === undefined)
                continue;
            let series = 0;
            for (const site of body.callSites) {
                if (site.fn === f)
                    series = series === 0 ? site.series.length : Math.min(series, site.series.length);
            }
            if (!checkList(shape, `${at}.functions[${f}]`, fn.code, { ...sizes, slots: fn.slots, series }, 'RET')) {
                return false;
            }
        }
        if (!checkBodies(shape, `${at}.requests`, body.requests, sizes))
            return false;
    }
    return true;
}
function tableSizes(program) {
    return {
        slots: program.frame.slots,
        cells: program.cells.length,
        states: program.states.length,
        registers: program.series.length,
        channels: program.channels.length,
        libFunctions: program.lib.functions.length,
        callSites: program.callSites.length,
        loops: program.loops.length,
        consts: program.consts.length,
        series: 0,
        argcOf: (site) => program.callSites[site]?.argc ?? 0,
    };
}
/**
 * The sizes inside a function body.
 *
 * A body's slots are its own frame's, and a `HISTP` indexes the series bindings
 * of whichever call site reached it. Every site that calls this function has to
 * bind the same number, because the operand is fixed in the body, so the
 * smallest binding list is the one that decides what is in range.
 */
function bodySizes(base, program, fn) {
    let series = 0;
    for (const site of program.callSites) {
        if (site.fn === fn)
            series = series === 0 ? site.series.length : Math.min(series, site.series.length);
    }
    return { ...base, slots: program.functions[fn]?.slots ?? 0, series };
}
//# sourceMappingURL=verify.js.map