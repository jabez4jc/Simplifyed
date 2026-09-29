import { buildCandle } from './candles.js';
import { cssColour } from './colours.js';
import { colourAt, colourColumns } from './columns.js';
import { boolField, colourField, isReference, numberField, stringField } from './fields.js';
/**
 * The seven styles a plot declaration may carry, in the chart's spelling.
 *
 * A name that is not one of them is drawn as a line. Load-time verification
 * enumerates a channel's type and not a plot's, so a program can reach here
 * carrying a style no engine has, and there is no catalogue code for a declared
 * plot style a host cannot draw. A line is the least wrong thing to draw and
 * inventing a code to refuse it is not this adapter's to do.
 */
const SERIES_TYPES = {
    line: 'line',
    lineWithMarkers: 'line-markers',
    step: 'step',
    area: 'area',
    histogram: 'histogram',
    column: 'column',
    candle: 'candlestick',
};
const SCALES = {
    right: 'right',
    left: 'left',
    none: '',
};
const LINE_STYLES = ['solid', 'dashed', 'dotted'];
/**
 * `ownPane` is whether the study draws in a pane of its own, which is what
 * decides whether the study's own scale formatting reaches a plot at all.
 */
export function buildPlots(program, lookup, ownPane) {
    const plots = [];
    const columns = [];
    for (const declared of program.outputs.plots) {
        const built = onePlot(program, declared, lookup, ownPane);
        plots.push(built.plot);
        columns.push(...built.columns);
    }
    return { plots, columns };
}
function onePlot(program, declared, lookup, ownPane) {
    const key = declared.key;
    const title = stringField(declared.title, lookup, key);
    const overlay = boolField(declared.overlay, lookup);
    const inOwnPane = ownPane && overlay !== true;
    const offset = numberField(declared.offset, lookup, 0);
    const columns = [{ key, channel: declared.channel, part: 'value' }];
    const candle = declared.ohlc === null ? undefined : buildCandle(key, declared.ohlc, lookup);
    if (candle !== undefined)
        columns.push(...candle.columns);
    if (declared.colorChannel !== null)
        columns.push(...colourColumns(key, declared.colorChannel));
    // A constant colour is nothing when the script named none, which leaves the
    // colour to the host's palette, and nothing when a channel carries it per bar,
    // because a constant beside a per-bar colour is a colour the plot never draws.
    const constant = candle === undefined && declared.colorChannel === null
        ? colourField(declared.color, lookup)
        : undefined;
    const style = {
        title,
        lineWidth: numberField(declared.width, lookup, 1.5),
        lineStyle: lineStyleOf(stringField(declared.lineStyle, lookup, 'solid')),
        ...(candle?.style ?? {}),
        ...(constant === undefined ? {} : { color: cssColour(constant) }),
    };
    const format = priceFormatOf(program, declared, lookup, inOwnPane);
    const plot = {
        key,
        type: SERIES_TYPES[declared.type] ?? 'line',
        title,
        style,
        priceScaleId: SCALES[stringField(declared.scale, lookup, 'right')] ?? 'right',
        ...(format === undefined ? {} : { priceFormat: format }),
        ...(overlay === undefined ? {} : { overlay }),
        ...(offset === 0 ? {} : { offset }),
        ...(isReference(declared.color) ? { colorKey: declared.color.input } : {}),
        ...(candle === undefined ? {} : { ohlc: candle.ohlc }),
        ...(candle?.colorParts === undefined ? {} : { colorParts: candle.colorParts }),
        ...(declared.colorChannel === null
            ? {}
            : {
                colorBy: (ctx) => colourAt(ctx.values, ctx.index, key),
            }),
    };
    return { plot, columns };
}
function lineStyleOf(value) {
    return LINE_STYLES.includes(value) ? value : 'solid';
}
/**
 * The value formatting of the scale this plot maps to.
 *
 * The plot's own `format` and `precision` win. The study's own are applied only
 * where the plot stays in the study's pane, so an overlaid column leaves the
 * instrument's axis exactly as the chart already formats it.
 */
function priceFormatOf(program, declared, lookup, inOwnPane) {
    const format = declared.priceFormat !== null
        ? stringField(declared.priceFormat, lookup, 'price')
        : inOwnPane
            ? stringField(program.meta.format, lookup, 'price')
            : undefined;
    if (format === undefined)
        return undefined;
    if (format === 'volume')
        return { type: 'volume' };
    const precision = declared.precision !== null
        ? numberField(declared.precision, lookup, 4)
        : inOwnPane
            ? numberField(program.meta.precision, lookup, 4)
            : undefined;
    const type = format === 'percent' ? 'percent' : 'price';
    return precision === undefined ? { type } : { type, precision };
}
//# sourceMappingURL=plots.js.map