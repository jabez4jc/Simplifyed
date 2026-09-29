import { stringField } from './fields.js';
import { producedFor } from './produced.js';
/** The key one alert's condition column travels under. */
export function alertKey(index) {
    return `openscript:alert:${index}`;
}
/**
 * Each declared alert's message channel, as the run left it.
 *
 * Indexed by the alert's position in `outputs.alerts`, so an entry the program
 * declares without a message channel holds an empty column rather than shifting
 * the ones after it.
 */
export function alertMessages(program, columns) {
    return program.outputs.alerts.map((declared) => {
        const channel = declared.messageChannel;
        return channel === null ? [] : (columns[channel] ?? []);
    });
}
/** The rows a user subscribes to, fixed before the first bar. */
export function buildAlerts(program, lookup) {
    const alerts = [];
    const columns = [];
    for (let index = 0; index < program.outputs.alerts.length; index += 1) {
        const declared = program.outputs.alerts[index];
        if (declared === undefined)
            continue;
        const key = alertKey(index);
        const title = stringField(declared.title, lookup, '');
        columns.push({ key, channel: declared.condChannel, part: 'flag' });
        alerts.push({
            id: declared.key,
            title,
            // A program whose alert has no message channel states no message, and the
            // chart's own default for that is the title. Declaring a function that
            // returned the title anyway would hide that fact behind this adapter.
            ...(declared.messageChannel === null
                ? {}
                : {
                    message: (ctx) => messageAt(producedFor(ctx.settings).messages[index], ctx.index) ?? title,
                }),
            when: (ctx) => ctx.values[key]?.[ctx.index] === 1,
        });
    }
    return { alerts, columns };
}
/** The message one bar published, or nothing where it published none. */
function messageAt(column, index) {
    const value = column?.[index];
    return typeof value === 'string' ? value : undefined;
}
//# sourceMappingURL=alerts.js.map