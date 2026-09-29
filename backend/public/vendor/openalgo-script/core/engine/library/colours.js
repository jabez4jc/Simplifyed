import { colour } from '../values/index.js';
import { colourAt, entry, numberAt } from './binding.js';
const CHANNELS = {
    aqua: [0, 255, 255],
    black: [0, 0, 0],
    blue: [0, 0, 255],
    brown: [165, 42, 42],
    fuchsia: [255, 0, 255],
    gray: [128, 128, 128],
    green: [0, 128, 0],
    lime: [0, 255, 0],
    maroon: [128, 0, 0],
    navy: [0, 0, 128],
    olive: [128, 128, 0],
    orange: [255, 165, 0],
    pink: [255, 192, 203],
    purple: [128, 0, 128],
    red: [255, 0, 0],
    silver: [192, 192, 192],
    teal: [0, 128, 128],
    white: [255, 255, 255],
    yellow: [255, 255, 0],
};
/** The nineteen names, for a test that has to compare two tables. */
export const COLOUR_NAMES = Object.keys(CHANNELS);
export function namedColour(name) {
    const channels = CHANNELS[name];
    return channels === undefined ? null : colour(channels[0], channels[1], channels[2], 1);
}
export const COLOUR_ENTRIES = [
    ...COLOUR_NAMES.map((name) => entry(name, '', () => namedColour(name))),
    entry('rgb', 'r g b', (_ctx, args) => {
        const r = numberAt(args, 0);
        const g = numberAt(args, 1);
        const b = numberAt(args, 2);
        if (r === null || g === null || b === null)
            return null;
        return colour(r, g, b, 1);
    }),
    entry('rgba', 'r g b a', (_ctx, args) => {
        const r = numberAt(args, 0);
        const g = numberAt(args, 1);
        const b = numberAt(args, 2);
        const a = numberAt(args, 3);
        if (r === null || g === null || b === null || a === null)
            return null;
        return colour(r, g, b, a);
    }),
    // `fade` takes transparency, not opacity, and the argument is a percentage:
    // 100 is invisible. Both spellings follow the way a chart's own style controls
    // are labelled, and the two conventions are opposites, so the arithmetic is
    // written out rather than left to a reader to infer from the name.
    entry('fade', 'color percent', (_ctx, args) => {
        const base = colourAt(args, 0);
        const percent = numberAt(args, 1);
        if (base === null || percent === null)
            return null;
        return colour(base.r, base.g, base.b, base.a * (1 - percent / 100));
    }),
    entry('mix', 'a b weight', (_ctx, args) => {
        const a = colourAt(args, 0);
        const b = colourAt(args, 1);
        const weight = numberAt(args, 2);
        if (a === null || b === null || weight === null)
            return null;
        const blend = (from, to) => from + (to - from) * weight;
        return colour(blend(a.r, b.r), blend(a.g, b.g), blend(a.b, b.b), blend(a.a, b.a));
    }),
    entry('alpha', 'color', (_ctx, args) => {
        const base = colourAt(args, 0);
        return base === null ? null : base.a;
    }),
    entry('withAlpha', 'color a', (_ctx, args) => {
        const base = colourAt(args, 0);
        const a = numberAt(args, 1);
        if (base === null || a === null)
            return null;
        return colour(base.r, base.g, base.b, a);
    }),
];
//# sourceMappingURL=colours.js.map