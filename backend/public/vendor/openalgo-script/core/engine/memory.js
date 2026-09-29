import { copyState } from './library/index.js';
import { ABSENT, storedValue } from './values/index.js';
export class Memory {
    values;
    initialised;
    live;
    regions;
    undoCells = new Map();
    undoRegions = new Map();
    constructor(cells, states) {
        this.values = new Array(cells.length).fill(ABSENT);
        this.initialised = new Array(cells.length).fill(false);
        this.live = cells.map((one) => one.kind === 'live');
        this.regions = new Array(states.length).fill(undefined);
    }
    /**
     * `CELL_INIT`: whether the cell is already initialised.
     *
     * The cell is marked before the initialiser runs, not after. The two differ
     * only if the initialiser could reach the same `CELL_INIT` again, which needs
     * recursion, which is an error; marking first means the flag is set by one
     * instruction rather than by a pair that must stay together across a jump.
     */
    initialise(cell) {
        if (this.initialised[cell] === true)
            return true;
        this.recordCell(cell);
        this.initialised[cell] = true;
        return false;
    }
    load(cell) {
        return this.values[cell] ?? ABSENT;
    }
    store(cell, value) {
        this.recordCell(cell);
        this.values[cell] = storedValue(value);
    }
    /** The region a `CALL_LIB` names, created on first use and kept across bars. */
    region(index) {
        const known = this.regions[index];
        if (known !== undefined) {
            if (!this.undoRegions.has(index))
                this.undoRegions.set(index, copyState(known));
            return known;
        }
        if (!this.undoRegions.has(index))
            this.undoRegions.set(index, undefined);
        const made = {};
        this.regions[index] = made;
        return made;
    }
    recordCell(cell) {
        if (this.undoCells.has(cell))
            return;
        this.undoCells.set(cell, {
            value: this.values[cell] ?? ABSENT,
            initialised: this.initialised[cell] === true,
        });
    }
    /** What each cell held when this bar began, which is what a debugger shows. */
    previousCells() {
        const out = new Map();
        for (const [cell, snapshot] of this.undoCells)
            out.set(cell, snapshot.value);
        return out;
    }
    /** 6.3: restore the checkpoint, except that `"live"` cells keep their value. */
    rollback() {
        for (const [cell, snapshot] of this.undoCells) {
            if (this.live[cell] === true)
                continue;
            this.values[cell] = snapshot.value;
            this.initialised[cell] = snapshot.initialised;
        }
        this.undoCells.clear();
        for (const [index, region] of this.undoRegions) {
            this.regions[index] = region;
        }
        this.undoRegions.clear();
    }
    /** The checkpoint at the end of this bar: everything since is accepted. */
    commit() {
        this.undoCells.clear();
        this.undoRegions.clear();
    }
    /** Every value a cell holds, for the heap's reachability walk. */
    walk(visit) {
        for (const value of this.values)
            visit(value);
    }
}
//# sourceMappingURL=memory.js.map