import { isDrawing, isNumber, reference } from '../values/index.js';
import { entry, refAt, valueAt, wholeAt } from './binding.js';
import { clearArray } from './arrays.js';
/** The drawing object a handle names, refusing one the script already deleted. */
function drawing(ctx, args, index) {
    const handle = refAt(args, index);
    if (handle === null)
        return undefined;
    const object = ctx.heap.get(handle.id);
    if (object === undefined || !isDrawing(object))
        return undefined;
    if (object.deleted)
        ctx.guard.deleted(ctx.span, object.kind, object.deletedAt);
    ctx.heap.touch(handle.id);
    return object;
}
/**
 * Creates one object, once the ceiling has been asked.
 *
 * The properties arrive as a function rather than as a record so that the
 * ceiling is charged before any of the work: a polyline copies its whole path
 * into the heap, and an engine that built that and then refused to keep it
 * would have spent the memory it was refusing to spend.
 */
function make(ctx, kind, props) {
    ctx.guard.drawing(ctx.span, ctx.heap.drawingCount());
    const id = ctx.heap.allocate({ kind, props: props(), deleted: false, deletedAt: -1 });
    return reference(id);
}
/** The numbers one path argument holds, or an empty path when it holds none. */
function pointsIn(ctx, args, index) {
    const held = ctx.heap.deref(valueAt(args, index));
    return held !== undefined && held.kind === 'array' ? held.items : [];
}
/**
 * A polyline's path, copied out of the two arrays that describe it.
 *
 * The arrays are paired by index over the longer of them, so a script that
 * supplies more times than prices gets a point with no price rather than a
 * shorter path: absence reaching a drawing surface is a gap the host draws as a
 * break (`language.md` 6.7), and dropping the odd points instead would quietly
 * redraw the shape. A value that is not a number is absent for the same reason.
 *
 * The copies are heap arrays, so they are rolled back, swept and counted like
 * every other object rather than being a second kind of storage.
 */
function path(ctx, args, first) {
    const times = pointsIn(ctx, args, first);
    const prices = pointsIn(ctx, args, first + 1);
    const length = Math.max(times.length, prices.length);
    const copy = (source) => {
        const items = [];
        for (let i = 0; i < length; i += 1) {
            const one = source[i];
            items.push(one !== undefined && isNumber(one) ? one : null);
        }
        return reference(ctx.heap.allocate({ kind: 'array', items }));
    };
    return { times: copy(times), prices: copy(prices) };
}
/** A mutator that writes named fields onto an existing object. */
function setter(name, params, fields) {
    return entry(name, params, (ctx, args) => {
        const object = drawing(ctx, args, 0);
        if (object === undefined)
            return null;
        object.props = { ...object.props, ...fields(args) };
        return null;
    });
}
export const OBJECT_ENTRIES = [
    entry('draw.line', 't1 p1 t2 p2 color width style extendLeft extendRight', (ctx, args) => make(ctx, 'line', () => ({
        t1: valueAt(args, 0),
        p1: valueAt(args, 1),
        t2: valueAt(args, 2),
        p2: valueAt(args, 3),
        color: valueAt(args, 4),
        width: valueAt(args, 5),
        style: valueAt(args, 6),
        extendLeft: valueAt(args, 7),
        extendRight: valueAt(args, 8),
    }))),
    entry('draw.label', 't p text color textColor align tooltip', (ctx, args) => make(ctx, 'label', () => ({
        t: valueAt(args, 0),
        p: valueAt(args, 1),
        text: valueAt(args, 2),
        color: valueAt(args, 3),
        textColor: valueAt(args, 4),
        align: valueAt(args, 5),
        tooltip: valueAt(args, 6),
    }))),
    entry('draw.box', 't1 p1 t2 p2 color fillColor opacity width text textColor tooltip', (ctx, args) => make(ctx, 'box', () => ({
        t1: valueAt(args, 0),
        p1: valueAt(args, 1),
        t2: valueAt(args, 2),
        p2: valueAt(args, 3),
        color: valueAt(args, 4),
        fillColor: valueAt(args, 5),
        opacity: valueAt(args, 6),
        width: valueAt(args, 7),
        text: valueAt(args, 8),
        textColor: valueAt(args, 9),
        tooltip: valueAt(args, 10),
    }))),
    entry('draw.polyline', 'times prices color width closed fillColor opacity', (ctx, args) => make(ctx, 'polyline', () => ({
        ...path(ctx, args, 0),
        color: valueAt(args, 2),
        width: valueAt(args, 3),
        closed: valueAt(args, 4),
        fillColor: valueAt(args, 5),
        opacity: valueAt(args, 6),
    }))),
    setter('draw.setFrom', 'obj t p', (args) => ({ t1: valueAt(args, 1), p1: valueAt(args, 2) })),
    setter('draw.setTo', 'obj t p', (args) => ({ t2: valueAt(args, 1), p2: valueAt(args, 2) })),
    setter('draw.setAt', 'obj t p', (args) => ({ t: valueAt(args, 1), p: valueAt(args, 2) })),
    setter('draw.setBounds', 'obj t1 p1 t2 p2', (args) => ({
        t1: valueAt(args, 1),
        p1: valueAt(args, 2),
        t2: valueAt(args, 3),
        p2: valueAt(args, 4),
    })),
    entry('draw.setPoints', 'obj times prices', (ctx, args) => {
        const object = drawing(ctx, args, 0);
        if (object === undefined)
            return null;
        object.props = { ...object.props, ...path(ctx, args, 1) };
        return null;
    }),
    setter('draw.setText', 'obj text', (args) => ({ text: valueAt(args, 1) })),
    setter('draw.setColor', 'obj color', (args) => ({ color: valueAt(args, 1) })),
    setter('draw.setTextColor', 'obj color', (args) => ({ textColor: valueAt(args, 1) })),
    setter('draw.setFillColor', 'obj color', (args) => ({ fillColor: valueAt(args, 1) })),
    setter('draw.setWidth', 'obj width', (args) => ({ width: valueAt(args, 1) })),
    setter('draw.setStyle', 'obj style', (args) => ({ style: valueAt(args, 1) })),
    setter('draw.setExtend', 'obj left right', (args) => ({
        extendLeft: valueAt(args, 1),
        extendRight: valueAt(args, 2),
    })),
    setter('draw.setTooltip', 'obj text', (args) => ({ tooltip: valueAt(args, 1) })),
    // Deleting twice is not an error: the script asked for the object to be gone
    // and it is gone. Only a change to a deleted object is OS4005.
    entry('draw.delete', 'obj', (ctx, args) => {
        const handle = refAt(args, 0);
        if (handle !== null)
            ctx.heap.deleteDrawing(handle.id, ctx.bar.index);
        return null;
    }),
    entry('draw.deleteAll', '', (ctx) => {
        for (const { id } of ctx.heap.drawings())
            ctx.heap.deleteDrawing(id, ctx.bar.index);
        return null;
    }),
    entry('draw.count', '', (ctx) => ctx.heap.drawingCount()),
    /**
     * `cell(t, row, col, text, ...)`: one cell of a grid for this bar.
     *
     * The buffer is emptied at step 3 of every execution, so a re-executed bar
     * rebuilds the whole grid and a checkpoint holds none of it. That is why a
     * grid needs no rollback of its own while a drawing object does.
     */
    entry('cell', 't row col text textColor bgColor align', (ctx, args) => {
        const handle = refAt(args, 0);
        if (handle === null)
            return null;
        const object = ctx.heap.get(handle.id);
        if (object === undefined || object.kind !== 'table')
            return null;
        const row = wholeAt(ctx, 'cell', 'row', args, 1);
        const col = wholeAt(ctx, 'cell', 'col', args, 2);
        if (row === null || col === null)
            return null;
        if (row >= object.rows || col >= object.cols) {
            ctx.guard.badCell(ctx.span, row, col, object.rows, object.cols);
        }
        const written = {
            row,
            col,
            text: valueAt(args, 3),
            textColor: valueAt(args, 4),
            bgColor: valueAt(args, 5),
            align: valueAt(args, 6),
        };
        object.cells.push(written);
        return null;
    }),
    entry('clear', 'handle', (ctx, args) => {
        if (clearArray(ctx, args))
            return null;
        const handle = refAt(args, 0);
        if (handle === null)
            return null;
        const object = ctx.heap.get(handle.id);
        if (object === undefined || object.kind !== 'table')
            return null;
        object.cells = [];
        return null;
    }),
];
//# sourceMappingURL=objects.js.map