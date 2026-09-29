import { isNumber } from './values/index.js';
/** The property pairs each kind anchors itself with, in order. */
const ANCHORS = {
    line: [
        ['t1', 'p1'],
        ['t2', 'p2'],
    ],
    box: [
        ['t1', 'p1'],
        ['t2', 'p2'],
    ],
    label: [['t', 'p']],
    polyline: [],
};
function numberOf(value) {
    return value !== undefined && isNumber(value) ? value : null;
}
/** A polyline's path, from the two arrays the object copied at the call. */
function pathOf(heap, object) {
    const times = heap.deref(object.props['times'] ?? null);
    const prices = heap.deref(object.props['prices'] ?? null);
    const timeItems = times !== undefined && times.kind === 'array' ? times.items : [];
    const priceItems = prices !== undefined && prices.kind === 'array' ? prices.items : [];
    const out = [];
    for (let i = 0; i < Math.max(timeItems.length, priceItems.length); i += 1) {
        out.push({ time: numberOf(timeItems[i]), price: numberOf(priceItems[i]) });
    }
    return out;
}
function anchorsOf(heap, object) {
    if (object.kind === 'polyline')
        return pathOf(heap, object);
    return ANCHORS[object.kind].map(([time, price]) => ({
        time: numberOf(object.props[time]),
        price: numberOf(object.props[price]),
    }));
}
function styleOf(object) {
    const anchored = new Set(['times', 'prices']);
    for (const [time, price] of ANCHORS[object.kind]) {
        anchored.add(time);
        anchored.add(price);
    }
    const out = {};
    for (const key of Object.keys(object.props)) {
        if (!anchored.has(key))
            out[key] = object.props[key] ?? null;
    }
    return out;
}
/**
 * Every object the script holds, oldest first.
 *
 * Creation order rather than any other, because it is the order the script
 * wrote and therefore the order a reader expects one drawing to sit over
 * another. Deleted objects are not here at all: an object lives until the
 * script deletes it, and then it is gone rather than hidden.
 */
export function drawingsIn(heap) {
    return heap.drawings().map(({ id, object }) => ({
        id,
        kind: object.kind,
        anchors: anchorsOf(heap, object),
        style: styleOf(object),
    }));
}
//# sourceMappingURL=drawings.js.map