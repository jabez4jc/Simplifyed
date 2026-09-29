import { colourAt, colourColumns } from './columns.js';
/** The key each paint channel's two colour columns travel under. */
const BAR_COLOR = 'openscript:barColor';
const BACKGROUND = 'openscript:background';
export function buildPaint(program) {
    const bar = oneOf(program.outputs.barColor, BAR_COLOR);
    const pane = oneOf(program.outputs.background, BACKGROUND);
    return {
        columns: [...bar.columns, ...pane.columns],
        barColors: bar.read,
        background: pane.read,
    };
}
function oneOf(paint, key) {
    if (paint === null)
        return { columns: [], read: undefined };
    return {
        columns: colourColumns(key, paint.channel),
        read: (ctx) => {
            const out = new Array(ctx.bars.length);
            for (let index = 0; index < out.length; index += 1) {
                out[index] = colourAt(ctx.values, index, key) ?? null;
            }
            return out;
        },
    };
}
/**
 * Which study's bar colouring is drawn, given the chart's own study order.
 *
 * The list is the host's, oldest first, which is the order a legend lists them
 * and the order a user changes deliberately. The answer is the last study in it
 * that paints: a study added on top of another is the one whose colouring the
 * user just asked to see, and adding a study that paints nothing changes
 * nothing.
 *
 * Nothing is returned when no study paints, which is the ordinary case.
 */
export function candleOwner(studies) {
    for (let index = studies.length - 1; index >= 0; index -= 1) {
        const study = studies[index];
        if (study !== undefined && study.barColors !== undefined)
            return study.id;
    }
    return undefined;
}
//# sourceMappingURL=paint.js.map