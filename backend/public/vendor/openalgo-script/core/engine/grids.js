/**
 * The grids a program declares, and the four points in the bar cycle they touch.
 *
 * A grid is the one output that is neither a channel nor an instruction.
 * `table()` emits no code at all: the declaration fixes the grid's shape before
 * bar 0, exactly as an input's does, and the engine puts the handle in the
 * declared slot at step 5 (`compiled-program.md` 2.8 and 5.1). Building one per
 * bar would give a script a different object every bar for something the format
 * calls part of the study's fixed shape, and a script that kept the handle in a
 * `var` would be holding last bar's grid.
 *
 * **The cells are a buffer, not a history.** Step 3 empties every grid's cells,
 * so what a host reads after a run is what the last executed bar wrote and
 * nothing before it. That is why a re-executed bar rebuilds its grid rather than
 * doubling it, why a checkpoint holds none of it, and why a hundred thousand
 * bars of history cost a host exactly one grid to draw.
 */
import { fieldValue } from './inputs.js';
import { reference } from './values/index.js';
export class Grids {
    heap;
    declared;
    constructor(program, inputs, heap) {
        this.heap = heap;
        const declared = [];
        for (const one of program.outputs.tables) {
            const rows = fieldValue(one.rows, inputs);
            const cols = fieldValue(one.cols, inputs);
            const id = heap.allocate({
                kind: 'table',
                rows: typeof rows === 'number' ? rows : 0,
                cols: typeof cols === 'number' ? cols : 0,
                cells: [],
            });
            declared.push({ key: one.key, slot: one.slot, id });
        }
        this.declared = declared;
        // The grids exist before the first bar, so nothing about them belongs to a
        // bar's undo journal.
        heap.commit();
    }
    get empty() {
        return this.declared.length === 0;
    }
    /** Step 3: every cell buffer starts each execution of a bar empty. */
    clear() {
        for (const grid of this.declared) {
            const object = this.heap.get(grid.id);
            if (object !== undefined && object.kind === 'table')
                object.cells = [];
        }
    }
    /** Step 5: each grid's handle lands in the slot its declaration named. */
    fill(slots) {
        for (const grid of this.declared)
            slots[grid.slot] = reference(grid.id);
    }
    /** A grid is reachable for as long as the study is, whatever a script holds. */
    walk(visit) {
        for (const grid of this.declared)
            visit(reference(grid.id));
    }
    /** The grids and the cells the last executed bar wrote into them. */
    read() {
        return this.declared.map((grid) => {
            const object = this.heap.get(grid.id);
            const table = object !== undefined && object.kind === 'table' ? object : undefined;
            return {
                key: grid.key,
                rows: table?.rows ?? 0,
                cols: table?.cols ?? 0,
                cells: table?.cells ?? [],
            };
        });
    }
}
//# sourceMappingURL=grids.js.map