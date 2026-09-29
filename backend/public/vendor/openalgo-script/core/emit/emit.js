/**
 * A checked file in, a compiled program out.
 *
 * The order below is the order the format forces, and each step is here rather
 * than inside a pass because each one needs a total the passes do not have
 * until they have finished.
 *
 * Registers first, because the two instructions that keep a shadow register in
 * step with a cell have to be the first and the last thing a bar does, and a
 * prologue cannot be written after the list it belongs at the front of. Inputs
 * next, because each one owns a slot the engine writes at step 5 and the slots
 * have to exist before a statement reads one. Then the statements. Then the
 * bases of every call site, which can only be assigned once the top level's own
 * cells and state regions are counted.
 *
 * The last step is the one worth defending: the emitter walks its own
 * instruction lists and computes the stack depth exactly as section 3.5 check 5
 * says an engine will. A compiler that cannot compute that number does not know
 * whether it emitted a program any engine will load, and finding out from a
 * verifier in another language is finding out too late.
 */
import { CATALOGUE_LANGUAGE_VERSION } from '../catalogue/index.js';
import { COMPILED_FORMAT_VERSION, VERSION } from '../version/index.js';
import { sourceHash } from './canonical.js';
import { orderChannels, renumberCode, renumberOutputs } from './channels.js';
import { walkDepths } from './code.js';
import { Emitter, Frame } from './context.js';
import { assignRegions } from './functions.js';
import { buildInputs } from './inputs.js';
import { buildLimits, buildMeta } from './meta.js';
import { placementOf, prepareRegisters } from './registers.js';
import { linkRequestNames } from './requests.js';
import { requiresOf } from './requires.js';
import { emitStatement } from './statements.js';
/** The library manifest version, tied to `openscript.language` (2.5). */
const DEFAULT_MANIFEST = 1;
export function emit(file, checked, sink, options = {}) {
    const e = new Emitter(file, checked, sink, options);
    const top = new Frame(true);
    prepareRegisters(e);
    buildInputs(e, top);
    openCarriedRegisters(e, top);
    linkRequestNames(e);
    for (const item of checked.script.items) {
        if (item.kind === 'functionDeclaration')
            continue;
        emitStatement(e, top, item);
    }
    closeShadowRegisters(e, top);
    // `HALT` takes the position of whatever came before it, which is 12.2's own
    // reading of a run of instructions costing one triple.
    if (top.builder.here === 0)
        top.builder.at(checked.script.span);
    top.builder.push('HALT');
    const { cells, states } = assignRegions(e, top);
    // The channel table is written in the order `outputs` lists its groups, which
    // is not the order the declarations were met in; `channels.ts` says why.
    const order = orderChannels(e);
    const code = renumberCode(top.builder.code, order.moved);
    const functions = e.functions.map((one) => ({
        ...one,
        code: renumberCode(one.code, order.moved),
    }));
    checkDepths(e, top, code);
    checkLimits(e, code, states.length);
    const program = {
        openscript: { format: COMPILED_FORMAT_VERSION, language: languageOf(checked) },
        requires: requiresOf(e, code),
        compiler: { name: 'openscript', version: VERSION },
        source: { hash: sourceHash(file.text), lines: file.lineCount, file: file.name },
        meta: buildMeta(e),
        limits: buildLimits(e),
        lib: { manifest: options.manifest ?? DEFAULT_MANIFEST, functions: e.libraryFunctions },
        inputs: e.inputs,
        channels: order.channels,
        outputs: renumberOutputs(e, order.moved),
        consts: e.pool.all,
        series: e.layout.registers,
        frame: { slots: top.layout.slotCount },
        cells,
        states,
        functions,
        callSites: e.sites.map((site) => ({
            fn: site.fn,
            argc: site.argc,
            cellBase: site.cellBase,
            stateBase: site.stateBase,
            series: site.series,
        })),
        loops: e.loops,
        code,
        requests: e.requests,
        debug: {
            pos: top.builder.pos,
            fnPos: e.functionPos,
            names: {
                slots: top.layout.slotNames,
                cells: cells.map((one) => one.name ?? ''),
                series: e.layout.registers.map((one) => one.name ?? ''),
                channels: order.names,
            },
            retain: options.retain === true,
        },
    };
    if (!e.gaps.blocked)
        return { program, gaps: e.gaps.gaps };
    reportRefusal(e);
    return { program: undefined, gaps: e.gaps.gaps };
}
/**
 * Why there is no program, said to the person who asked for one.
 *
 * A gap is a note between the parts of this project and nobody outside it ever
 * reads one, so an emitter that returned nothing and logged a gap left a trader
 * with a compile that produced no program, no message and nothing to ask a
 * question about. That is the worst failure this compiler has available: the
 * script may be perfectly good, and silence gives its author no way to find out
 * whether it is.
 *
 * So every gap that stopped a program becomes a diagnostic. It carries the line
 * that provoked it, what could not be done, and the section that asks for it,
 * and it says where to take it. The sentence is careful about whose fault it
 * is, because this runs whether or not an earlier stage refused the file: a
 * checked tree the emitter cannot emit is a defect in the compiler only when
 * nothing else was reported about it.
 */
function reportRefusal(e) {
    for (const gap of e.gaps.gaps) {
        if (!gap.blocking)
            continue;
        e.sink.report('OS6018', gap.span ?? e.checked.script.span, {
            location: gap.specification,
            reason: `${gap.what}; this compiler produced no program rather than a wrong one, and if ` +
                'nothing else was reported about this script that is a defect in the compiler ' +
                'rather than in the script: please report it, with the script that produced it',
        });
    }
}
function languageOf(checked) {
    const line = checked.script.items.find((item) => item.kind === 'versionLine');
    return line !== undefined && line.kind === 'versionLine'
        ? line.version.value
        : CATALOGUE_LANGUAGE_VERSION;
}
/**
 * The register beside a `var` a function body reads, filled before the bar runs.
 *
 * The pair at the end of the bar (below) writes the entry for the bar. This one
 * writes the value the bar starts with, so a body called before the first
 * assignment reads what the cell carried in rather than an absence. On bar 0
 * the cell has not been initialised yet and reads absent, which is what the
 * name is worth before its declaration line (3.4).
 */
function openCarriedRegisters(e, top) {
    for (const binding of e.checked.bindings) {
        if (!e.carried.has(binding.id))
            continue;
        const register = e.layout.registerFor(binding);
        if (register === undefined)
            continue;
        top.builder.at(binding.declaredAt);
        top.builder.push('LOADC', top.layout.cellFor(binding));
        top.builder.push('SSTORE', register);
    }
}
/**
 * The one instruction pair that keeps a persistent name's past readable.
 *
 * A cell has no history and a register has no persistence, so `x[1]` on a `var`
 * needs both (`language.md` 8.3). The register's entry for a bar is written
 * from the cell at the end of the bar rather than at each assignment, because a
 * bar on which the `var` was not assigned still holds a value, and a register
 * written only where the source writes the name would be absent there and say
 * the value had never existed.
 */
function closeShadowRegisters(e, top) {
    for (const binding of e.checked.bindings) {
        if (!e.shadowed.has(binding.id))
            continue;
        if (placementOf(e, binding) !== 'cell')
            continue;
        if (!top.layout.hasCellFor(binding))
            continue;
        const register = e.layout.registerFor(binding);
        if (register === undefined)
            continue;
        top.builder.at(binding.declaredAt);
        top.builder.push('LOADC', top.layout.cellFor(binding));
        top.builder.push('SSTORE', register);
    }
}
/** Every instruction a read's body holds, its own reads included. */
function instructionsIn(requests) {
    let total = 0;
    for (const request of requests) {
        total += request.body.code.length;
        for (const one of request.body.functions)
            total += one.code.length;
        total += instructionsIn(request.body.requests);
    }
    return total;
}
/** Section 3.5 check 5, run here so a defect is found where it was written. */
function checkDepths(e, top, code) {
    const argcOf = (site) => e.sites[site]?.argc ?? 0;
    const lists = [code, ...e.functions.map((one) => one.code)];
    for (const request of e.requests)
        checkRequestDepths(e, request);
    lists.forEach((list, index) => {
        const walk = walkDepths(list, argcOf);
        const at = walk.conflict ?? walk.underflow ?? walk.terminal;
        if (at === undefined)
            return;
        e.gap(`the stack depth this compiler emitted does not survive its own walk at instruction ${at}, ` +
            'so an engine would refuse the program at load', 'compiled-program.md 3.5 check 5', 
        // The bar's own list is the one whose positions are to hand, and it is
        // where all but one of these can happen. A line beats no line: whoever
        // reads this next starts at the statement rather than at the file.
        index === 0 ? lineOfInstruction(e, top, at) : undefined, true);
    });
}
/**
 * The same walk over a read's body, which counts its own call sites (2.16).
 *
 * A body has no positions in the bar's own table, so a failure here carries the
 * read's line rather than a line from the wrong list.
 */
function checkRequestDepths(e, request) {
    const argcOf = (site) => request.body.callSites[site]?.argc ?? 0;
    const lists = [request.body.code, ...request.body.functions.map((one) => one.code)];
    for (const list of lists) {
        const walk = walkDepths(list, argcOf);
        const at = walk.conflict ?? walk.underflow ?? walk.terminal;
        if (at === undefined)
            continue;
        e.gap(`the stack depth this compiler emitted for a read's expression does not survive its ` +
            `own walk at instruction ${at}, so an engine would refuse the program at load`, 'compiled-program.md 3.5 check 5 and 2.16', undefined, true);
    }
    for (const nested of request.body.requests)
        checkRequestDepths(e, nested);
}
/** Where the instruction at this index came from, from the debug positions. */
function lineOfInstruction(e, top, index) {
    let found;
    for (const position of top.builder.pos) {
        if (position[0] > index)
            break;
        found = position;
    }
    if (found === undefined)
        return undefined;
    return e.file.spanAt(e.file.offsetAt({ line: found[1], column: found[2] }), 1);
}
/**
 * OS5004 and OS5009, the two limits the compiler rather than the engine finds.
 *
 * Both are reported only against a ceiling a host actually declared. A compiler
 * that invented one would refuse a program every engine present could run.
 */
function checkLimits(e, code, states) {
    const span = e.checked.script.span;
    const maxStates = e.options.maxStates;
    if (maxStates !== undefined && states > maxStates) {
        e.sink.report('OS5004', span, {
            found: states,
            max: maxStates,
            first: e.functions[0]?.name ?? '',
            second: e.functions[1]?.name ?? e.functions[0]?.name ?? '',
        });
    }
    const maxInstructions = e.options.maxInstructions;
    const total = code.length +
        e.functions.reduce((sum, one) => sum + one.code.length, 0) +
        // A read's expression is instructions an engine executes, once per
        // requested bar, so it counts against the ceiling like any other (2.16).
        instructionsIn(e.requests);
    if (maxInstructions !== undefined && total > maxInstructions) {
        e.sink.report('OS5009', span, { found: total, max: maxInstructions });
    }
}
//# sourceMappingURL=emit.js.map