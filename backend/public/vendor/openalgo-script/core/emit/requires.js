/** The tags of format 1.0, in the order 2.2's table gives them. */
const ORDER = [
    'core.1',
    'arrays',
    'functions',
    'loops',
    'orders',
    'objects',
    'tables',
    'alerts',
    'req.timeframe',
    'req.symbol',
];
const DRAWN_OBJECTS = ['line', 'label', 'box', 'polyline'];
function mentionsArray(type) {
    if (type.kind === 'array')
        return true;
    if (type.kind === 'series')
        return mentionsArray(type.element);
    return false;
}
function isArrayFunction(entry) {
    return (mentionsArray(entry.returns) || entry.parameters.some((one) => mentionsArray(one.type)));
}
function createsObject(entry) {
    return entry.returns.kind === 'object' && DRAWN_OBJECTS.includes(entry.returns.object);
}
function usesArrayInstruction(lists) {
    return lists.some((code) => code.some(([opcode]) => opcode === 'ARRAY' || opcode === 'ELEM'));
}
/**
 * Every instruction list in the program, the bodies of its reads included.
 *
 * A tag says what the program needs, and a read's expression is part of the
 * program: an engine that cannot run an `ELEM` cannot run one inside a read
 * either, and a tag derived from the bar's list alone would tell it otherwise.
 */
function codeOf(lists, requests) {
    for (const request of requests) {
        lists.push([...request.body.code]);
        for (const one of request.body.functions)
            lists.push([...one.code]);
        codeOf(lists, request.body.requests);
    }
}
function loopsIn(requests) {
    return requests.some((one) => one.body.loops.length > 0 || loopsIn(one.body.requests));
}
export function requiresOf(e, code) {
    const lists = [[...code], ...e.functions.map((one) => [...one.code])];
    codeOf(lists, e.requests);
    const needed = new Set(['core.1']);
    if (usesArrayInstruction(lists) || e.calledEntries.some(isArrayFunction))
        needed.add('arrays');
    if (e.checked.functions.length > 0)
        needed.add('functions');
    if (e.loops.length > 0 || loopsIn(e.requests))
        needed.add('loops');
    if (e.libraryFunctions.some((one) => one.effect === 'order'))
        needed.add('orders');
    if (e.calledEntries.some(createsObject))
        needed.add('objects');
    if (e.tables.length > 0)
        needed.add('tables');
    if (e.alerts.length > 0)
        needed.add('alerts');
    for (const request of e.checked.requests)
        needed.add(request.name);
    return ORDER.filter((tag) => needed.has(tag));
}
//# sourceMappingURL=requires.js.map