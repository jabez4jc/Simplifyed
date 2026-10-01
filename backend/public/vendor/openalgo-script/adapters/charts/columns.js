import { isColourValue, packChannels, unpackColour } from './colours.js';
/** The key a level's price column travels under. */
export function levelKey(index) {
    return `openscript:level:${index}`;
}
/** The key one side of a band's computed colour travels under. */
export function bandColourKey(band, side) {
    return `openscript:fill:${band}:${side}`;
}
/** The two keys a per-bar colour travels under. */
export function colourKeys(key) {
    return { rgb: `${key}:rgb`, alpha: `${key}:alpha` };
}
/** The colour a per-bar channel carried on one bar, as a chart spells one. */
export function colourAt(values, index, key) {
    const keys = colourKeys(key);
    const rgb = values[keys.rgb]?.[index];
    const alpha = values[keys.alpha]?.[index];
    if (typeof rgb !== 'number' || typeof alpha !== 'number')
        return undefined;
    return unpackColour(rgb, alpha);
}
/** The two column specifications a per-bar colour channel needs. */
export function colourColumns(key, channel) {
    const keys = colourKeys(key);
    return [
        { key: keys.rgb, channel, part: 'rgb' },
        { key: keys.alpha, channel, part: 'alpha' },
    ];
}
/**
 * The table, for bars `from` up to `to`.
 *
 * `from` is zero for a full recompute and the first changed bar for a tail, and
 * the chart splices a tail onto what it already holds. Every key the full path
 * produces is produced here too, because a key the tail leaves out is dropped
 * from the spliced result rather than kept.
 */
export function valuesFrom(specs, columns, from, to) {
    const out = {};
    for (const spec of specs) {
        const built = new Array(Math.max(0, to - from));
        if (spec.part === 'bar') {
            // The bar's own index, never its offset into the tail: the chart splices
            // a tail by position, so a row carries the same number either way.
            for (let bar = from; bar < to; bar += 1)
                built[bar - from] = bar;
        }
        else {
            const column = columns[spec.channel] ?? [];
            for (let bar = from; bar < to; bar += 1) {
                built[bar - from] = partOf(column[bar] ?? null, spec.part);
            }
        }
        out[spec.key] = built;
    }
    return out;
}
function partOf(value, part) {
    if (part === 'value')
        return typeof value === 'number' ? value : null;
    if (part === 'flag')
        return value === true ? 1 : null;
    if (!isColourValue(value))
        return null;
    return part === 'rgb' ? packChannels(value) : value.a;
}
//# sourceMappingURL=columns.js.map