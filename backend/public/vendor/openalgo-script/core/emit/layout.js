/** One frame's slots, its cells and the library state its body needs. */
export class FrameLayout {
    slotNames = [];
    cellNames = [];
    cellKinds = [];
    /** Relative state index to the index into `lib.functions` that owns it. */
    stateFns = [];
    bindingSlot = new Map();
    bindingCell = new Map();
    /** A slot with no name in the source: a loop's limit, a step, a cursor. */
    slot(name) {
        const index = this.slotNames.length;
        this.slotNames.push(name);
        return index;
    }
    slotFor(binding) {
        const found = this.bindingSlot.get(binding.id);
        if (found !== undefined)
            return found;
        const index = this.slot(binding.name);
        this.bindingSlot.set(binding.id, index);
        return index;
    }
    hasSlotFor(binding) {
        return this.bindingSlot.has(binding.id);
    }
    cellFor(binding) {
        const found = this.bindingCell.get(binding.id);
        if (found !== undefined)
            return found;
        const index = this.cellNames.length;
        this.cellNames.push(binding.name);
        this.cellKinds.push(binding.persistence === 'live' ? 'live' : 'var');
        this.bindingCell.set(binding.id, index);
        return index;
    }
    hasCellFor(binding) {
        return this.bindingCell.has(binding.id);
    }
    /** A per-call-site region for a stateful library call, relative to the base. */
    state(libraryFunction) {
        const index = this.stateFns.length;
        this.stateFns.push(libraryFunction);
        return index;
    }
    get slotCount() {
        return this.slotNames.length;
    }
}
/**
 * The tables that are one per program rather than one per frame.
 *
 * A register, a channel and a library function entry are addressed the same way
 * from every frame, which is what lets a function body read a series and write
 * a plot column without knowing where it was called from.
 */
export class Layout {
    registers = [];
    channels = [];
    channelNames = [];
    barFields = new Map();
    bindingRegister = new Map();
    /** The register the engine fills from the host's bar, 2.10. One per field. */
    bar(field) {
        const found = this.barFields.get(field);
        if (found !== undefined)
            return found;
        const id = this.registers.length;
        this.registers.push({ id, kind: 'bar', field, name: field });
        this.barFields.set(field, id);
        return id;
    }
    /** A top-level name whose history the program reads, written by `SSTORE`. */
    computedFor(binding) {
        const found = this.bindingRegister.get(binding.id);
        if (found !== undefined)
            return found;
        const id = this.computed(binding.name);
        this.bindingRegister.set(binding.id, id);
        return id;
    }
    hasComputedFor(binding) {
        return this.bindingRegister.has(binding.id);
    }
    registerFor(binding) {
        return this.bindingRegister.get(binding.id);
    }
    computed(name) {
        const id = this.registers.length;
        this.registers.push({ id, kind: 'computed', field: null, name });
        return id;
    }
    /** A series argument retained for one call site, 2.10 and 4.10. */
    argument(name) {
        const id = this.registers.length;
        this.registers.push({ id, kind: 'argument', field: null, name });
        return id;
    }
    /**
     * A register the engine fills rather than the program, 2.10 and 2.16.
     *
     * A read's value per chart bar, and a setting a read's expression needs on
     * every requested bar. Neither is ever written by an instruction, which is
     * why neither is a `computed`.
     */
    filled(kind, name) {
        const id = this.registers.length;
        this.registers.push({ id, kind, field: null, name });
        return id;
    }
    channel(type, defer, once, name) {
        const id = this.channels.length;
        this.channels.push({ id, type, defer, once });
        this.channelNames.push(name);
        return id;
    }
}
/** The cells of one frame, as the program's `cells[]` carries them. */
export function cellsOf(frame, base) {
    return frame.cellKinds.map((kind, index) => ({
        id: base + index,
        kind,
        name: frame.cellNames[index] ?? null,
    }));
}
//# sourceMappingURL=layout.js.map