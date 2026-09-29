import { isRef, reference } from './value.js';
export function isDrawing(object) {
    return object.kind !== 'array' && object.kind !== 'table';
}
function copyObject(object) {
    if (object.kind === 'array')
        return { kind: 'array', items: [...object.items] };
    if (object.kind === 'table') {
        return { kind: 'table', rows: object.rows, cols: object.cols, cells: [...object.cells] };
    }
    return {
        kind: object.kind,
        props: { ...object.props },
        deleted: object.deleted,
        deletedAt: object.deletedAt,
    };
}
export class Heap {
    objects = [];
    free = [];
    /** Drawing object ids in creation order, which is the order a host draws them. */
    drawingIds = [];
    /** A copy of each object taken before the first change this bar made to it. */
    taken = new Map();
    /** Ids allocated during this bar, oldest first. */
    created = [];
    /** The drawing roster's length when this bar began. */
    drawingsAtBarStart = 0;
    liveAtSweep = 0;
    sinceSweep = 0;
    elements = 0;
    /**
     * Drawing objects created and not yet deleted, kept as a running count.
     *
     * Counted rather than measured because two things ask for it on the hot
     * path: `draw.count()` on every bar and the object ceiling on every
     * creation. Walking the roster for each would make a study that holds ten
     * thousand objects quadratic in the number it holds, which is the study the
     * ceiling exists for. The count is adjusted by the same journal that undoes
     * everything else, so a rolled back creation is a rolled back count.
     */
    drawingsLive = 0;
    /** Objects alive right now, which is what a heap ceiling counts. */
    liveCount() {
        return this.objects.length - this.free.length;
    }
    /** Drawing objects the script has created and not deleted. */
    drawingCount() {
        return this.drawingsLive;
    }
    /** Total array elements held. */
    elementCount() {
        return this.elements;
    }
    get(id) {
        return this.objects[id];
    }
    /** The object a reference names, or nothing when the value is not one. */
    deref(value) {
        return isRef(value) ? this.objects[value.id] : undefined;
    }
    allocate(object) {
        const reused = this.free.pop();
        const id = reused ?? this.objects.length;
        this.objects[id] = object;
        this.created.push(id);
        this.sinceSweep += 1;
        if (object.kind === 'array')
            this.elements += object.items.length;
        if (isDrawing(object)) {
            this.drawingIds.push(id);
            this.drawingsLive += 1;
        }
        return id;
    }
    /**
     * Delete one drawing object, which is the only thing that ends its life.
     *
     * Here rather than in the library call so that the roster, the count and the
     * journal cannot disagree: a caller that set the flag itself would leave the
     * count saying one thing and the objects another, and the first symptom
     * would be a ceiling refusing a script that had deleted everything.
     *
     * Deleting twice does nothing and is not an error. The script asked for the
     * object to be gone and it is gone; only a change to a deleted object is
     * OS4005.
     */
    deleteDrawing(id, bar) {
        const object = this.objects[id];
        if (object === undefined || !isDrawing(object) || object.deleted)
            return;
        this.touch(id);
        object.deleted = true;
        object.deletedAt = bar;
        this.drawingsLive -= 1;
    }
    /**
     * Announce a change to an object before making it.
     *
     * The copy is taken once per bar per object: the journal only has to restore
     * the state the bar started in, so the second change to the same object has
     * nothing to record.
     */
    touch(id) {
        if (this.taken.has(id))
            return;
        const object = this.objects[id];
        if (object === undefined)
            return;
        this.taken.set(id, copyObject(object));
    }
    /** Called after an array's length changes, so the ceiling sees it. */
    countElements(delta) {
        this.elements += delta;
    }
    /** The drawing objects a host should see, in creation order. */
    drawings() {
        const out = [];
        for (const id of this.drawingIds) {
            const object = this.objects[id];
            if (object === undefined || !isDrawing(object) || object.deleted)
                continue;
            out.push({ id, object });
        }
        return out;
    }
    /** Undo every change this bar made, which is section 6.3 for the heap. */
    rollback() {
        for (const [id, object] of this.taken) {
            const current = this.objects[id];
            if (current !== undefined && current.kind === 'array' && object.kind === 'array') {
                this.elements += object.items.length - current.items.length;
            }
            // A deletion this bar made is undone with everything else, so the object
            // comes back and the count comes back with it.
            if (current !== undefined && isDrawing(current) && isDrawing(object)) {
                this.drawingsLive += (object.deleted ? 0 : 1) - (current.deleted ? 0 : 1);
            }
            this.objects[id] = object;
        }
        this.taken.clear();
        for (let i = this.created.length - 1; i >= 0; i -= 1) {
            const id = this.created[i];
            if (id === undefined)
                continue;
            const object = this.objects[id];
            if (object !== undefined && object.kind === 'array')
                this.elements -= object.items.length;
            // An object created and then deleted on the same bar was counted out of
            // the roster by the deletion, so only a live one is counted out here.
            if (object !== undefined && isDrawing(object) && !object.deleted)
                this.drawingsLive -= 1;
            this.objects[id] = undefined;
            this.free.push(id);
            this.sinceSweep -= 1;
        }
        this.created = [];
        this.drawingIds.length = this.drawingsAtBarStart;
    }
    /** Accept every change this bar made. The journal starts again empty. */
    commit() {
        this.taken.clear();
        this.created = [];
        this.drawingsAtBarStart = this.drawingIds.length;
    }
    /** Drop what nothing can reach. Only at a checkpoint, and only when it pays. */
    sweep(roots) {
        if (this.sinceSweep < this.liveAtSweep + 256)
            return;
        const live = new Set();
        const pending = [];
        const visit = (value) => {
            if (!isRef(value) || live.has(value.id))
                return;
            if (this.objects[value.id] === undefined)
                return;
            live.add(value.id);
            pending.push(value.id);
        };
        roots(visit);
        // Every drawing object that has not been deleted is a root of its own: the
        // surface holds it, so a script that draws a box and keeps no name for it
        // still gets a box.
        for (const id of this.drawingIds) {
            const object = this.objects[id];
            if (object !== undefined && isDrawing(object) && !object.deleted)
                visit(reference(id));
        }
        while (pending.length > 0) {
            const id = pending.pop();
            if (id === undefined)
                continue;
            const object = this.objects[id];
            if (object === undefined)
                continue;
            if (object.kind === 'array')
                for (const item of object.items)
                    visit(item);
            else if (object.kind === 'table') {
                for (const cell of object.cells) {
                    visit(cell.text);
                    visit(cell.textColor);
                    visit(cell.bgColor);
                }
            }
            else
                for (const key of Object.keys(object.props))
                    visit(object.props[key] ?? null);
        }
        for (let id = 0; id < this.objects.length; id += 1) {
            const object = this.objects[id];
            if (object === undefined || live.has(id))
                continue;
            if (object.kind === 'array')
                this.elements -= object.items.length;
            // A drawing that has not been deleted is a root of its own, so this
            // subtracts nothing in practice. It is written because the day the roots
            // change is the day a silently wrong count would start.
            if (isDrawing(object) && !object.deleted)
                this.drawingsLive -= 1;
            this.objects[id] = undefined;
            this.free.push(id);
        }
        this.drawingIds = this.drawingIds.filter((id) => live.has(id));
        this.drawingsAtBarStart = this.drawingIds.length;
        this.liveAtSweep = live.size;
        this.sinceSweep = 0;
    }
}
//# sourceMappingURL=heap.js.map