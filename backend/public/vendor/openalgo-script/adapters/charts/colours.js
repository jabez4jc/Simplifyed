/** `#rgb`, `#rrggbb`, `#rrggbbaa`, and the two functional forms. */
const HEX = /^#([0-9a-f]{3,8})$/i;
const FUNCTIONAL = /^rgba?\(([^)]*)\)$/i;
/** The CSS spelling of a colour. */
export function cssColour(colour) {
    return `rgba(${colour.r}, ${colour.g}, ${colour.b}, ${colour.a})`;
}
/** The CSS spelling of a value that may not be a colour at all. */
export function cssOf(value) {
    return isColourValue(value) ? cssColour(value) : undefined;
}
export function isColourValue(value) {
    return typeof value === 'object' && value !== null && value.tag === 'color';
}
export function colourOf(r, g, b, a) {
    return { tag: 'color', r: channel(r), g: channel(g), b: channel(b), a: a < 0 ? 0 : a > 1 ? 1 : a };
}
/**
 * A CSS colour back into the language's four numbers.
 *
 * `alpha` is what a value with no alpha of its own is given: the alpha the
 * script declared for that input, so a swatch that cannot express transparency
 * does not remove it. Anything unparseable is nothing, which the caller turns
 * into the refusal the input's own validation would have produced.
 */
export function parseColour(text, alpha) {
    const trimmed = text.trim();
    const hex = HEX.exec(trimmed);
    if (hex !== null) {
        const digits = hex[1] ?? '';
        const wide = digits.length === 3 || digits.length === 4;
        if (!wide && digits.length !== 6 && digits.length !== 8)
            return undefined;
        const at = (index) => {
            const pair = wide
                ? `${digits.charAt(index)}${digits.charAt(index)}`
                : digits.slice(index * 2, index * 2 + 2);
            return Number.parseInt(pair, 16);
        };
        const opaque = digits.length === 4 || digits.length === 8;
        return colourOf(at(0), at(1), at(2), opaque ? at(3) / 255 : alpha);
    }
    const functional = FUNCTIONAL.exec(trimmed);
    if (functional === null)
        return undefined;
    const parts = (functional[1] ?? '')
        .split(/[\s,/]+/)
        .filter((one) => one.length > 0)
        .map((one) => Number(one));
    if (parts.length < 3 || parts.some((one) => !Number.isFinite(one)))
        return undefined;
    const [r, g, b, a] = parts;
    return colourOf(r, g, b, a ?? alpha);
}
/** The three channels as one whole number, for a column of per-bar colours. */
export function packChannels(colour) {
    return (colour.r * 256 + colour.g) * 256 + colour.b;
}
/** The CSS spelling of a packed triple and the alpha that travelled beside it. */
export function unpackColour(packed, alpha) {
    const b = packed % 256;
    const g = ((packed - b) / 256) % 256;
    const r = (packed - b - g * 256) / 65_536;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
/**
 * A whole channel inside the range a chart can draw.
 *
 * A colour arriving from a chart has whole channels already: every control that
 * writes one writes an integer. The rounding is here for a hand written string
 * rather than as a rule of the language, whose own rounding applies where a
 * script computes a colour and is the engine's to apply, not this module's.
 */
function channel(x) {
    if (!Number.isFinite(x))
        return 0;
    const whole = Math.round(x);
    return whole < 0 ? 0 : whole > 255 ? 255 : whole;
}
//# sourceMappingURL=colours.js.map