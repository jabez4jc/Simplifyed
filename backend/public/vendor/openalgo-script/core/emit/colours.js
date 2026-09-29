const OPAQUE = 1;
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
export function isColourName(name) {
    return Object.prototype.hasOwnProperty.call(CHANNELS, name);
}
/** The colour a name denotes, at full opacity, or nothing if it is not one. */
export function namedColour(name) {
    const channels = CHANNELS[name];
    return channels === undefined
        ? undefined
        : [channels[0], channels[1], channels[2], OPAQUE];
}
/**
 * A `#rrggbb` or `#rrggbbaa` literal, `language.md` 3.8.
 *
 * The alpha byte is divided by 255 here rather than left to an engine, because
 * `compiled-program.md` 2.9 requires the pool to carry the divided number: two
 * engines dividing separately is a place they can differ by one part in 255.
 */
export function hexColour(text) {
    const digits = text.startsWith('#') ? text.slice(1) : text;
    if (digits.length !== 6 && digits.length !== 8)
        return undefined;
    if (!/^[0-9a-fA-F]+$/.test(digits))
        return undefined;
    const byte = (at) => Number.parseInt(digits.slice(at, at + 2), 16);
    const alpha = digits.length === 8 ? byte(6) / 255 : OPAQUE;
    return [byte(0), byte(2), byte(4), alpha];
}
//# sourceMappingURL=colours.js.map