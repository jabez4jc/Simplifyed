import { withoutGrouping } from '../ast/index.js';
import { Frame as EmitFrame, argumentAt, declaredNames } from './context.js';
import { emitExpression } from './expressions.js';
import { assignRegions } from './functions.js';
import { RequestScope } from './request-scope.js';
import { fieldOf } from './values.js';
/**
 * The chart facts that can fix part of a request's identity.
 *
 * Three of the facts of `stdlib.md` 3.4 name an instrument or an interval, and
 * one of them is the documented default of `req.symbol`'s `exchange`. The rest
 * describe the chart rather than identify it, and a request built from one of
 * those has no meaning to carry.
 */
const CHART_IDENTITY = ['symbol', 'exchange', 'interval'];
/** The two reads of `stdlib.md` 15.1, and the two that ask after one. */
export const REQUEST_CALLS = new Set(['req.timeframe', 'req.symbol']);
export const REQUEST_STATUS_CALLS = new Set(['req.isReady', 'req.error']);
/**
 * A read, as a value on this bar: the register the engine filled for it.
 *
 * One request per call written in the source, however many call paths reach it.
 * A body emitted twice, which 2.12 does for a function reached two ways, asks
 * the host the same question twice otherwise, and the host's ceiling on
 * outstanding requests counts both.
 */
export function emitRequestRead(e, f, call, checked) {
    const register = registerFor(e, call, checked);
    f.builder.at(call.span);
    if (register === undefined) {
        f.builder.push('CONST', e.pool.absent());
        return;
    }
    f.builder.push('SLOAD', register);
}
/**
 * The request a status call names, for `req.isReady` and `req.error`.
 *
 * Both name a read rather than taking its value, and a value on a bar cannot
 * say which request produced it, so the compiler resolves the argument to the
 * request's id and passes that. It is the same resolution `fill` does on a plot
 * handle (2.8), and the reason is the same: the argument is a compile-time
 * identity wearing the clothes of a value.
 *
 * **A read written inline is registered here and not only resolved**, which is
 * the whole of the second half of this function. The checker gives every read
 * in the file an id whether or not anything else in the file uses its value, and
 * an id on its own names nothing an engine was handed: the compiled program
 * would carry no request under it, the host would never be asked, and
 * `req.error` would answer the empty string for a read the host refused. That is
 * the one answer this pair of calls exists to make impossible, and it held only
 * for the form written as a name. So the inline form emits its request the same
 * way the value form does, and asks the host the same question.
 */
export function requestIdFor(e, expression) {
    const inner = withoutGrouping(expression);
    if (inner.kind === 'nameReference') {
        const binding = e.bindingAt(inner);
        return binding === undefined ? undefined : e.requestOf.get(binding.id);
    }
    if (inner.kind !== 'call')
        return undefined;
    const checked = e.callAt(inner);
    if (checked === undefined || !REQUEST_CALLS.has(checked.name))
        return undefined;
    const found = checkedRequestFor(e, inner);
    if (found === undefined)
        return undefined;
    registerFor(e, inner, checked);
    return found.id;
}
/**
 * Which name holds which read, before a statement is emitted.
 *
 * `req.isReady(dayHigh)` is resolved against this, and the call may be written
 * above the line that declares the name it asks about, so the links are made
 * before any of them is needed rather than as each declaration is met.
 */
export function linkRequestNames(e) {
    for (const declared of declaredNames(e)) {
        if (withoutGrouping(declared.value).kind !== 'call')
            continue;
        const request = e.checked.requests.find((one) => one.call === withoutGrouping(declared.value));
        const binding = e.checked.targets.get(declared.name);
        if (request !== undefined && binding !== undefined)
            e.requestOf.set(binding.id, request.id);
    }
}
function checkedRequestFor(e, call) {
    return e.checked.requests.find((one) => one.call === call);
}
function registerFor(e, call, checked) {
    const found = checkedRequestFor(e, call);
    if (found === undefined)
        return undefined;
    const already = e.requestSeries.get(found.id);
    if (already !== undefined)
        return already;
    const entry = checked.entry;
    const argument = (name) => {
        if (entry === undefined)
            return undefined;
        return argumentAt(checked, entry, name)?.value;
    };
    const expression = argument('expr');
    const name = nameOf(e, found);
    const register = e.layout.filled('request', name);
    e.requestSeries.set(found.id, register);
    const request = {
        id: found.id,
        read: found.name === 'req.symbol' ? 'symbol' : 'timeframe',
        symbol: fieldFrom(e, argument('symbol'), 'symbol'),
        exchange: fieldFrom(e, argument('exchange'), 'exchange'),
        timeframe: fieldFrom(e, argument('timeframe'), 'timeframe'),
        mode: modeOf(e, found),
        series: register,
        warmup: warmupOf(e, expression),
        body: bodyOf(e, expression),
    };
    e.requests.push(request);
    return register;
}
/** The name the source gave the read, for `debug` and for a reader. */
function nameOf(e, request) {
    for (const [binding, id] of e.requestOf) {
        if (id !== request.id)
            continue;
        const found = e.checked.bindings.find((one) => one.id === binding);
        if (found !== undefined)
            return found.name;
    }
    return request.name;
}
/**
 * One of the three fields that fix a request's identity.
 *
 * All three are settled before bar 0, which is what lets the whole set of
 * requests be known at load (`host-interface.md` 5.2) and what makes a request
 * that changed afterwards OS6013. A value this compiler cannot fold is neither
 * a value nor a reference to one setting, so there is nothing to write, and the
 * line that wrote it is told so rather than a program being emitted that names
 * an instrument nobody asked for.
 */
function fieldFrom(e, written, option) {
    if (written === undefined)
        return null;
    const fact = chartFactOf(e, written);
    if (fact !== undefined)
        return { chart: fact };
    const value = e.fold(written);
    if (value !== undefined)
        return fieldOf(value);
    e.sink.report('OS3003', written.span, { option });
    return null;
}
/** `chart.symbol`, `chart.exchange` or `chart.interval`, written as a name. */
function chartFactOf(e, written) {
    const inner = withoutGrouping(written);
    if (inner.kind !== 'member')
        return undefined;
    const object = withoutGrouping(inner.object);
    if (object.kind !== 'nameReference' || object.name !== 'chart')
        return undefined;
    if (e.bindingAt(object) !== undefined)
        return undefined;
    return CHART_IDENTITY.find((one) => one === inner.member.text);
}
function modeOf(e, request) {
    if (request.mode !== 'unknown')
        return request.mode;
    // The mode decides whether the study may repaint, so it is read at compile
    // time or not at all (`stdlib.md` 15.3).
    e.sink.report('OS3003', request.span, { option: 'mode' });
    return 'confirmed';
}
/**
 * The bars of requested history the body needs, when a number is known.
 *
 * A host extends the requested range backwards by it (`host-interface.md` 5.2).
 * It is a floor rather than a promise, because a length that comes from a
 * setting is not known until the setting resolves: a host that extends by less
 * gets a read that is absent for longer, never a wrong number.
 */
function warmupOf(e, expression) {
    if (expression === undefined)
        return null;
    const found = e.checked.warmups.get(expression);
    if (found === undefined || found.kind === 'never')
        return null;
    return found.bar;
}
function bodyOf(e, expression) {
    const scope = new RequestScope();
    const sub = e.forRequest(scope);
    const top = new EmitFrame(true);
    if (expression === undefined) {
        top.builder.at(e.checked.script.span);
        top.builder.push('CONST', sub.pool.absent());
    }
    else {
        emitExpression(sub, top, expression);
        top.builder.at(expression.span);
    }
    // The body ends the way a function body does: the value it leaves is the
    // read's value for that requested bar, and `RET` is what hands it over
    // (4.10). Nothing new is asked of an engine's instruction loop.
    top.builder.push('RET');
    const { cells, states } = assignRegions(sub, top);
    return {
        inputs: scope.inputs,
        series: sub.layout.registers,
        frame: { slots: top.layout.slotCount },
        cells,
        states,
        functions: sub.functions,
        callSites: sub.sites.map((site) => ({
            fn: site.fn,
            argc: site.argc,
            cellBase: site.cellBase,
            stateBase: site.stateBase,
            series: site.series,
        })),
        loops: sub.loops,
        requests: sub.requests,
        code: top.builder.code,
        pos: top.builder.pos,
        fnPos: sub.functionPos,
    };
}
//# sourceMappingURL=requests.js.map