import { cssColour } from './colours.js';
import { bandColourKey, colourAt, colourColumns } from './columns.js';
import { boolField, colourField, isReference, numberField } from './fields.js';
/**
 * The fade a band with no declared colour is drawn at, `stdlib.md` 14.2.
 *
 * It is written here because the adapter has to multiply it by the script's own
 * opacity, and a chart applies its own default only where the field is absent.
 */
const UNCOLOURED_FADE = 0.12;
/** What a bar whose computed colour is absent is painted in: nothing. */
const UNPAINTED = 'rgba(0, 0, 0, 0)';
export function buildFills(program, lookup, chart) {
    const fills = [];
    const columns = [];
    program.outputs.fills.forEach((band, index) => {
        const perBar = chart.bandColours ? perBarColours(band, index) : undefined;
        if (perBar !== undefined)
            columns.push(...perBar.columns);
        fills.push(oneBand(program, band, lookup, perBar));
    });
    return { fills, columns };
}
/**
 * The columns a band's computed colours need, or nothing for a band with none.
 *
 * `color = ...` computed per bar writes one channel into both sides, and that
 * channel travels once rather than twice.
 */
function perBarColours(band, index) {
    const upChannel = band.colorUpChannel;
    const downChannel = band.colorDownChannel;
    if (upChannel === null && downChannel === null)
        return undefined;
    const up = upChannel === null ? undefined : bandColourKey(index, 'up');
    const shared = downChannel !== null && downChannel === upChannel;
    const down = downChannel === null ? undefined : shared ? up : bandColourKey(index, 'down');
    const columns = [];
    if (up !== undefined && upChannel !== null)
        columns.push(...colourColumns(up, upChannel));
    if (down !== undefined && downChannel !== null && !shared)
        columns.push(...colourColumns(down, downChannel));
    return { up, down, columns };
}
function oneBand(program, band, lookup, perBar) {
    const up = colourField(band.colorUp, lookup);
    const down = colourField(band.colorDown, lookup);
    const overlay = boolField(band.overlay, lookup);
    const computed = band.colorUpChannel !== null || band.colorDownChannel !== null;
    const declared = up !== undefined || down !== undefined || computed;
    const opacity = numberField(band.opacity, lookup, 1) * (declared ? 1 : UNCOLOURED_FADE);
    const follow = declared ? undefined : plotColourKey(program, band.between[0]);
    return {
        between: band.between,
        ...(up === undefined ? {} : { colorUp: cssColour(up) }),
        ...(down === undefined ? {} : { colorDown: cssColour(down) }),
        ...(isReference(band.colorUp) ? { colorUpKey: band.colorUp.input } : {}),
        ...(isReference(band.colorDown) ? { colorDownKey: band.colorDown.input } : {}),
        ...(follow === undefined ? {} : { colorUpKey: follow, colorDownKey: follow }),
        opacity,
        ...(overlay === undefined ? {} : { overlay }),
        ...(perBar === undefined ? {} : { colorBy: colourBy(perBar) }),
    };
}
/**
 * The band's colour on one bar: the computed colour for the side it is on.
 *
 * Nothing where either column is absent, which is a bar the chart does not
 * draw, and nothing where that side's colour is not computed, which leaves the
 * chart the band's own colour for the side.
 */
function colourBy(perBar) {
    return (ctx) => {
        if (typeof ctx.a !== 'number' || typeof ctx.b !== 'number')
            return undefined;
        const key = ctx.a >= ctx.b ? perBar.up : perBar.down;
        if (key === undefined)
            return undefined;
        return colourAt(ctx.values, ctx.index, key) ?? UNPAINTED;
    };
}
/**
 * The settings key holding a plot's colour.
 *
 * A chart generates one appearance row per plot and names it after the plot,
 * except where the plot declares a colour key of its own, which is what a plot
 * whose colour came from an `input()` does. The two cases are the same two this
 * adapter produces in `plots.ts`.
 */
function plotColourKey(program, key) {
    const plot = program.outputs.plots.find((one) => one.key === key);
    if (plot !== undefined && isReference(plot.color))
        return plot.color.input;
    return `${key}:color`;
}
//# sourceMappingURL=fills.js.map