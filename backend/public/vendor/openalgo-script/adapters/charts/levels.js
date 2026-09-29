import { cssColour } from './colours.js';
import { levelKey } from './columns.js';
import { colourField, numberField, rangeField, stringField } from './fields.js';
import { lookupFor } from './settings.js';
const LINE_STYLES = ['solid', 'dashed', 'dotted'];
export function buildLevels(program) {
    const columns = program.outputs.levels.map((declared, index) => ({
        key: levelKey(index),
        channel: declared.channel,
        part: 'value',
    }));
    return {
        columns,
        levels(ctx) {
            const lookup = lookupFor(program, settingsOf(ctx));
            const out = [];
            for (let index = 0; index < program.outputs.levels.length; index += 1) {
                const declared = program.outputs.levels[index];
                if (declared === undefined)
                    continue;
                const column = ctx.values?.[levelKey(index)];
                const price = column === undefined ? undefined : column[column.length - 1];
                if (typeof price !== 'number')
                    continue;
                const colour = colourField(declared.color, lookup);
                const title = stringField(declared.title, lookup, '');
                const style = stringField(declared.lineStyle, lookup, 'dashed');
                out.push({
                    price,
                    ...(colour === undefined ? {} : { color: cssColour(colour) }),
                    ...(title === '' ? {} : { title }),
                    lineWidth: numberField(declared.lineWidth, lookup, 1),
                    lineStyle: LINE_STYLES.includes(style) ? style : 'dashed',
                });
            }
            return out;
        },
    };
}
/**
 * The study's own pane range, or nothing when it fixed none.
 *
 * It is read per call rather than once, because `range` is one of the fields a
 * script may write with an `input()`, and a chart asks again whenever the
 * settings change.
 */
export function buildRange(program) {
    return (settings) => rangeField(program.meta.range, lookupFor(program, settings));
}
/**
 * The settings a level context carries.
 *
 * The context spreads the settings keys onto itself and also carries them under
 * `settings`, so a caller that built one by hand from a settings bag alone still
 * works: the named member when there is one, the context itself otherwise.
 */
function settingsOf(ctx) {
    const named = ctx.settings;
    return named === undefined ? ctx : named;
}
//# sourceMappingURL=levels.js.map