/**
 * Which values get a series register, and which of the three regions a name
 * ends up in.
 *
 * The checker answers most of this already: a top-level name whose history the
 * program reads is a register, a `var` is a cell, everything else is a slot
 * (`compiled-program.md` 2.10 and 2.11). Two cases are left over, and both are
 * the emitter's because both are about the shape of the instruction set rather
 * than about the language.
 *
 * **A persistent name whose history is read is both.** `x[1]` on a `var` is
 * "both" in `language.md` 8.3's own words: the cell carries the value forward
 * and the register carries the past. Only a register has history, so a `var`
 * the program indexes needs one beside its cell.
 *
 * **A slot cannot be read from another frame.** Slots are per frame (3.2), so a
 * function body that reads a file-scope name has no instruction that reaches
 * it. A name recomputed every bar can be given a register instead, which is
 * addressed the same way from every frame and holds the same value the slot
 * would have. A `var` cannot be promoted that way, because a register has no
 * persistence: it keeps its cell and takes a register beside it, filled from
 * the cell at the start of the bar and again at every assignment, so a body
 * called anywhere in the bar reads what the cell holds at that point.
 */
import { walk, withoutGrouping } from '../ast/index.js';
import { declaredNames } from './context.js';
/** The bar fields an engine fills from the host's bar, `compiled-program.md` 2.10. */
export const BAR_FIELDS = [
    'open',
    'high',
    'low',
    'close',
    'volume',
    'time',
    'hl2',
    'hlc3',
    'ohlc4',
    'hlcc4',
    'oi',
];
/** The `bar.*` facts of `language.md` 7.2, which 2.10 makes registers as well. */
export const BAR_FACTS = [
    'bar.index',
    'bar.count',
    'bar.isFirst',
    'bar.isLast',
    'bar.isConfirmed',
    'bar.isRealtime',
    'bar.isNew',
    'bar.updates',
];
/** `oi` is a built-in series and 2.10's table of bar fields does not list it. */
const UNLISTED_BAR_FIELD = 'oi';
/**
 * The register a built-in series is read from, or nothing when the name is not
 * one.
 */
export function registerOfName(e, name) {
    if (name === UNLISTED_BAR_FIELD) {
        e.gap("`oi` is a built-in series of stdlib.md 3.1 and 2.10's table of bar register fields " +
            'does not list it, so the field name it is filled from is this compiler\'s choice', 'compiled-program.md 2.10, against stdlib.md 3.1', undefined, false);
        return e.layout.bar(UNLISTED_BAR_FIELD);
    }
    if (BAR_FIELDS.includes(name) || BAR_FACTS.includes(name))
        return e.layout.bar(name);
    return undefined;
}
/**
 * Names whose value is a declaration handle, which `var` cannot change.
 *
 * A handle is settled before bar 0 and the engine writes it into the slot the
 * declaration names (2.11), so there is nothing for a cell to carry forward and
 * nothing to carry it forward from: `var grid = table(...)` and
 * `grid = table(...)` are the same declaration, and a reader who wrote the
 * first should not get a different program from the second.
 */
export function markDeclarationHandles(e) {
    for (const declared of declaredNames(e)) {
        const inner = withoutGrouping(declared.value);
        if (inner.kind !== 'call')
            continue;
        const name = e.callAt(inner)?.name ?? '';
        if (!e.isDeclaration(name))
            continue;
        // `input()` is the one declaration call that also has a value, so it is the
        // one a `var` says something about: `var len = input(14, "Length")` is an
        // ordinary `var` initialised from the setting, and what it buys is a cell a
        // later assignment keeps (`language.md` 8.2 and 13.4). The name therefore
        // does not stand for the declaration the way `grid = table(...)` does, and
        // the input keeps a slot of its own for the engine to write at step 5.
        if (declared.persistent && name === 'input')
            continue;
        const binding = e.checked.targets.get(declared.name);
        if (binding !== undefined)
            e.handles.add(binding.id);
    }
}
/** Where a name's value lives, the checker's answer with the three cases above. */
export function placementOf(e, binding) {
    if (e.handles.has(binding.id))
        return 'slot';
    if (binding.persistence !== 'none')
        return 'cell';
    if (binding.storage === 'register' || e.promoted.has(binding.id))
        return 'register';
    return 'slot';
}
/** The register a history read of a name reads from, allocating it if needed. */
export function shadowRegister(e, binding) {
    // A setting read inside a read's expression already has one, filled by the
    // engine on every requested bar, and a second would hold nothing (2.16).
    return e.request?.registerFor(e, binding) ?? e.layout.computedFor(binding);
}
/**
 * Decides every register before a single instruction is emitted.
 *
 * It has to happen first because the prologue and the epilogue that keep a
 * shadow register in step with its cell are instructions like any other, and
 * they cannot be written after the list they belong at the ends of.
 */
export function prepareRegisters(e) {
    markDeclarationHandles(e);
    const readInsideFunction = namesReadInsideFunctions(e);
    for (const binding of e.checked.bindings) {
        if (binding.kind === 'library' || binding.kind === 'function')
            continue;
        const crossesFrame = binding.kind === 'file' && readInsideFunction.has(binding.id);
        const retained = e.options.retain === true && binding.kind === 'file';
        if (binding.persistence === 'none' && (crossesFrame || retained)) {
            e.promoted.add(binding.id);
        }
        const placement = placementOf(e, binding);
        if (placement === 'register') {
            e.layout.computedFor(binding);
            continue;
        }
        // A `var` a function body reads cannot be promoted, because a register has
        // no persistence: it gets a register beside its cell instead, and the two
        // are kept in step through the bar rather than only at the end of it.
        if (placement === 'cell' && crossesFrame) {
            e.layout.computedFor(binding);
            e.shadowed.add(binding.id);
            e.carried.add(binding.id);
            continue;
        }
        // A cell or an input slot whose past is read carries a register beside it,
        // written once per bar so the entry for a bar is the value it ended with.
        if (binding.readsHistory) {
            e.layout.computedFor(binding);
            e.shadowed.add(binding.id);
        }
    }
}
/** Every file-scope name some function body reads, which a slot cannot serve. */
function namesReadInsideFunctions(e) {
    const found = new Set();
    for (const declared of e.checked.functions) {
        walk(declared.declaration, {
            enter: (node) => {
                if (node.kind !== 'nameReference')
                    return;
                const binding = e.checked.references.get(node);
                if (binding !== undefined && binding.kind === 'file')
                    found.add(binding.id);
            },
        });
    }
    return found;
}
//# sourceMappingURL=registers.js.map