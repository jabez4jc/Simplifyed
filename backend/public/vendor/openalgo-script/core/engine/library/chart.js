import { deferred, entry } from './binding.js';
/**
 * Minutes in an interval code, or absent for a code that is not intraday.
 *
 * The grammar is the smallest thing that covers the codes a host serves: a
 * count of minutes written bare, or a count with a unit letter. It is derived
 * rather than read so that a study cannot see a `chart.interval` of one value
 * and a `chart.intervalMinutes` of another.
 */
const INTERVAL = /^(\d+)([smhDWM]?)$/;
const MINUTES = {
    s: 1 / 60,
    '': 1,
    m: 1,
    h: 60,
    D: 60 * 24,
    W: 60 * 24 * 7,
};
function intervalMinutes(code) {
    if (code === null)
        return null;
    const parsed = INTERVAL.exec(code);
    if (parsed === null)
        return null;
    const count = Number(parsed[1]);
    const unit = parsed[2] ?? '';
    // A month is not a fixed number of minutes, so it has no answer here rather
    // than an average that would be wrong in every month.
    if (unit === 'M')
        return null;
    const scale = MINUTES[unit];
    return scale === undefined ? null : count * scale;
}
export const CHART_ENTRIES = [
    entry('chart.symbol', '', (ctx) => ctx.host.symbol()),
    entry('chart.exchange', '', (ctx) => ctx.host.exchange()),
    entry('chart.interval', '', (ctx) => ctx.host.interval()),
    entry('chart.timezone', '', (ctx) => ctx.host.timezone()),
    entry('chart.tickSize', '', (ctx) => ctx.host.tickSize()),
    entry('chart.lotSize', '', (ctx) => ctx.host.lotSize()),
    entry('chart.pointValue', '', (ctx) => ctx.host.pointValue()),
    entry('chart.currency', '', (ctx) => ctx.host.currency()),
    entry('chart.instrumentType', '', (ctx) => ctx.host.instrumentType()),
    entry('chart.hasVolume', '', (ctx) => ctx.host.hasVolume()),
    entry('chart.hasOpenInterest', '', (ctx) => ctx.host.hasOpenInterest()),
    entry('chart.now', '', (ctx) => ctx.host.now()),
    entry('chart.intervalMinutes', '', (ctx) => {
        const code = ctx.host.interval();
        return intervalMinutes(typeof code === 'string' ? code : null);
    }),
    entry('chart.isIntraday', '', (ctx) => {
        const code = ctx.host.interval();
        const minutes = intervalMinutes(typeof code === 'string' ? code : null);
        return minutes === null ? null : minutes < 60 * 24;
    }),
    entry('req.isReady', 'read', (ctx, args) => ctx.host.requestReady(args[0] ?? null)),
    entry('req.error', 'read', (ctx, args) => ctx.host.requestError(args[0] ?? null)),
    entry('session.isFirstBar', '', (ctx) => ctx.bar.isSessionFirst),
    entry('session.isLastBar', '', (ctx) => ctx.bar.isSessionLast),
    entry('pos.size', '', (ctx) => ctx.position.size()),
    entry('pos.avgPrice', '', (ctx) => ctx.position.avgPrice()),
    entry('pos.isLong', '', (ctx) => sideOf(ctx.position.size(), 1)),
    entry('pos.isShort', '', (ctx) => sideOf(ctx.position.size(), -1)),
    entry('pos.isFlat', '', (ctx) => sideOf(ctx.position.size(), 0)),
    deferred('print', 'value', 'log'),
    deferred('buy', 'qty limit stop tag leg', 'order'),
    deferred('sell', 'qty limit stop tag leg', 'order'),
    deferred('close', 'tag qty leg', 'order'),
    deferred('exit', 'tag qty limit stop profit loss leg', 'order'),
    deferred('cancel', 'tag', 'order'),
    deferred('cancelAll', '', 'order'),
    deferred('order.place', 'side qty type price trigger tag leg', 'order'),
    deferred('order.reverse', 'qty tag leg', 'order'),
    deferred('order.bracket', 'tag profit loss leg', 'order'),
];
/** Which side a position is on, absent where the size is not a number. */
function sideOf(size, want) {
    if (typeof size !== 'number')
        return null;
    const side = size > 0 ? 1 : size < 0 ? -1 : 0;
    return side === want;
}
//# sourceMappingURL=chart.js.map