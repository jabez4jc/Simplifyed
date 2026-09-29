import { alertMessages, buildAlerts } from './alerts.js';
import { capabilitiesOf } from './capabilities.js';
import { valuesFrom } from './columns.js';
import { buildDrawings } from './drawings.js';
import { buildFills } from './fills.js';
import { boolField, stringField } from './fields.js';
import { buildLevels, buildRange } from './levels.js';
import { buildMarkers } from './markers.js';
import { buildPaint } from './paint.js';
import { buildPlots } from './plots.js';
import { producedFor, remember } from './produced.js';
import { stationIn } from './requests.js';
import { fullRun, release, tailRun } from './run.js';
import { inputRows, lookupFor } from './settings.js';
import { buildTables, firstGrid } from './tables.js';
/** The grey an unnamed marker is drawn in, where the host names no default. */
const MARKER_COLOUR = 'rgba(128, 128, 128, 1)';
export function descriptorFor(program, options = {}) {
    // The declared shape is fixed before bar 0, so the fields that make it up are
    // read once, against the settings the host states. A host that states none
    // gets the declared defaults, which is what a script with no `input()` in a
    // declaration option has anyway. The ones a settings change may move
    // afterwards carry a settings key instead of a value, and the two that cannot
    // are read again per call: a level's style and the pane's range.
    const declared = lookupFor(program, options.settings ?? {});
    // Which of the descriptor's newer hooks the host's chart reads. A hook it may
    // not read is left off, and what needs one is refused before a bar runs.
    const chart = capabilitiesOf(options.chartVersion);
    const overlay = boolField(program.meta.overlay, declared) === true;
    const plots = buildPlots(program, declared, !overlay);
    const levels = buildLevels(program);
    const fills = buildFills(program, declared, chart);
    const paint = buildPaint(program);
    const alerts = buildAlerts(program, declared);
    const columns = [
        ...plots.columns,
        ...levels.columns,
        ...paint.columns,
        ...alerts.columns,
        ...fills.columns,
    ];
    const markerColour = options.markerColor ?? MARKER_COLOUR;
    /**
     * What the run produced that is not a column of numbers.
     *
     * It is keyed by the settings object the chart handed in, because that object
     * is the study instance: the same one reaches every hook that follows the
     * calculation, and `produced.ts` says why that is the only handle there is.
     */
    const keep = (bars, settings, ran) => {
        const lookup = lookupFor(program, settings);
        remember(settings, {
            markers: buildMarkers(program, lookup, bars, ran.columns, markerColour),
            tables: buildTables(program, lookup, ran.tables),
            drawings: buildDrawings(ran.drawings),
            messages: alertMessages(program, ran.columns),
        });
    };
    // A study's own group is its category, and a host may name one for a script
    // whose author left the group blank.
    const group = stringField(program.meta.group, declared, '');
    const category = group === '' ? options.category : group;
    return {
        id: options.id ?? `openscript:${program.source.hash}`,
        name: stringField(program.meta.title, declared, 'Study'),
        ...(category === undefined ? {} : { category }),
        placement: overlay ? 'onchart' : 'pane',
        inputs: inputRows(program),
        plots: plots.plots,
        ...(fills.fills.length === 0 ? {} : { fills: fills.fills }),
        ...(alerts.alerts.length === 0 ? {} : { alerts: alerts.alerts }),
        calc(bars, settings, store, ctx) {
            const ran = fullRun(program, bars, settings, store, ctx, options);
            keep(bars, settings, ran);
            return valuesFrom(columns, ran.columns, 0, bars.length);
        },
        calcTail(bars, settings, fromIndex, _previous, store, ctx) {
            const ran = tailRun(program, bars, fromIndex, settings, store, ctx, options);
            if (ran === null)
                return null;
            keep(bars, settings, ran);
            return valuesFrom(columns, ran.columns, fromIndex, bars.length);
        },
        ...(program.outputs.levels.length === 0 ? {} : { levels: levels.levels }),
        ...(program.meta.range === null ? {} : { range: buildRange(program) }),
        ...(paint.barColors === undefined ? {} : { barColors: paint.barColors }),
        ...(paint.background === undefined ? {} : { background: paint.background }),
        ...(program.outputs.markers.length === 0
            ? {}
            : {
                markers: (ctx) => producedFor(ctx.settings).markers,
            }),
        ...(program.outputs.tables.length === 0
            ? {}
            : {
                table: (ctx) => firstGrid(producedFor(ctx.settings).tables),
            }),
        ...(program.outputs.tables.length === 0 || !chart.grids
            ? {}
            : {
                tables: (ctx) => producedFor(ctx.settings).tables,
            }),
        ...(program.requires.includes('objects')
            ? {
                draws: (ctx) => producedFor(ctx.settings).drawings,
            }
            : {}),
        // A study that reads only this chart's bars needs no lifecycle: the engine
        // folds its own, and a descriptor that declared one anyway would cost every
        // host a subscription for a transport nothing asks to use.
        ...(program.requires.includes('req.symbol')
            ? {
                attach(ctx) {
                    stationIn(ctx.store).open(ctx);
                    return () => {
                        release(ctx.store);
                    };
                },
            }
            : {}),
    };
}
//# sourceMappingURL=descriptor.js.map