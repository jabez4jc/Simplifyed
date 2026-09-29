import { namedColour } from './colours.js';
const ABSENT = { kind: 'absent' };
function number(value) {
    return { kind: 'number', value };
}
function string(value) {
    return { kind: 'string', value };
}
function bool(value) {
    return { kind: 'bool', value };
}
function colour(name) {
    const value = namedColour(name);
    return value === undefined ? ABSENT : { kind: 'colour', value };
}
/** `language.md` 13.2. `title` is required and `short` falls back to it. */
export const STUDY_DEFAULTS = {
    overlay: bool(false),
    precision: number(4),
    format: string('price'),
    range: ABSENT,
    scale: string('right'),
    group: string(''),
    onUnconfirmed: bool(false),
};
/** `language.md` 13.3, the options only a `strategy()` adds. */
export const STRATEGY_DEFAULTS = {
    capital: number(100000),
    currency: string(''),
    qty: number(1),
    qtyType: string('units'),
    product: string('intraday'),
    fillOn: string('nextOpen'),
    slippage: number(0),
    commission: number(0),
    commissionType: string('perTrade'),
    pyramiding: number(1),
    closeOnSessionEnd: bool(false),
};
/** The order `meta.strategy` lists them in, 2.3. */
export const STRATEGY_OPTIONS = [
    'capital',
    'currency',
    'qty',
    'qtyType',
    'product',
    'fillOn',
    'slippage',
    'commission',
    'commissionType',
    'pyramiding',
    'closeOnSessionEnd',
];
/**
 * `stdlib.md` 14.2.
 *
 * `lineStyle` has no argument on `plot` at all: the call's `style` names the
 * column's shape and becomes the entry's `type`. A plot therefore always
 * carries the one line style a host draws an undecorated line with.
 */
export const PLOT_DEFAULTS = {
    color: ABSENT,
    width: number(1.5),
    style: string('line'),
    offset: number(0),
    overlay: ABSENT,
    precision: ABSENT,
    format: ABSENT,
    scale: string('right'),
};
export const PLOT_LINE_STYLE = string('solid');
/** `stdlib.md` 14.2. A candle's border takes a plot's own width and style. */
export const CANDLE_DEFAULTS = {
    colorUp: colour('lime'),
    colorDown: colour('red'),
    wickColor: ABSENT,
    borderColor: ABSENT,
};
export const FILL_DEFAULTS = {
    color: ABSENT,
    colorUp: ABSENT,
    colorDown: ABSENT,
    opacity: number(1),
    overlay: ABSENT,
};
export const LEVEL_DEFAULTS = {
    title: string(''),
    color: colour('gray'),
    style: string('dashed'),
    width: number(1),
};
/** `stdlib.md` 14.3. `title`, `rows` and `cols` have no default. */
export const TABLE_DEFAULTS = {
    position: string('topRight'),
    textColor: ABSENT,
    bgColor: ABSENT,
    borderWidth: number(0),
};
export const MARKER_DEFAULTS = {
    color: ABSENT,
    at: string('above'),
    shape: string('label'),
};
export const ALERT_DEFAULTS = {
    id: string(''),
    title: string(''),
    frequency: string('oncePerBar'),
};
/** `stdlib.md` 13.2, the arguments every input kind accepts. */
export const INPUT_DEFAULTS = {
    group: string(''),
    tooltip: string(''),
};
/** `language.md` 10.7 and 7.4, carried by `limits` whether or not it was written. */
export const LOOP_BUDGET = 2_000_000;
/**
 * Which map holds each declaration call's defaults.
 *
 * The association is made at the call sites in `outputs.ts`, `events.ts` and
 * `inputs.ts`, where each map is read for the call it belongs to, and there was
 * nothing to read it off in one place. `scripts/check-defaults.mjs` therefore
 * carried a copy of it, and so would anything else that wanted to know what a
 * `plot` written without a `width` is given. It is written once here instead,
 * and that check holds it to the surface: a declaration call with optional
 * parameters and no map fails, and a key in a map that is not a parameter of
 * its call fails.
 */
export const DECLARATION_DEFAULTS = {
    plot: PLOT_DEFAULTS,
    plotCandles: CANDLE_DEFAULTS,
    fill: FILL_DEFAULTS,
    level: LEVEL_DEFAULTS,
    table: TABLE_DEFAULTS,
    signal: MARKER_DEFAULTS,
    alert: ALERT_DEFAULTS,
    input: INPUT_DEFAULTS,
};
/** A colour as the specification's tables print one, so the two compare. */
function hexOf(colour) {
    const byte = (channel) => Math.round(channel).toString(16).padStart(2, '0');
    return `#${byte(colour[0])}${byte(colour[1])}${byte(colour[2])}${byte(colour[3] * 255)}`;
}
/**
 * What a declaration call's omitted argument resolves to, spelled as a default.
 *
 * A `plot` or a `level` carries no default in the library manifest, because its
 * optional arguments become fields of a declaration rather than arguments an
 * engine is passed (`compiled-program.md` 2.3), and this file is where their
 * values are. So a reader of the manifest alone sees `width?: number` with no
 * value beside it while the compiler writes 1.5, and anything that showed a
 * writer the manifest's answer would be showing them nothing where the compiler
 * has something.
 *
 * This is the one answer to that question. `scripts/check-defaults.mjs` compares
 * what it returns against what `stdlib.md` prints, so a tooltip built on it
 * cannot state a default the compiler does not apply: the two are the same text
 * from the same table, or the build fails.
 *
 * Nothing comes back for a parameter whose value is absence, because absence is
 * not a default a writer can be shown: the specification states `none` for some
 * of those and words in place of a value for others, and which is which is
 * recorded in `spec/default-exceptions.json` rather than invented here.
 */
export function declarationDefaultText(call, parameter) {
    const value = DECLARATION_DEFAULTS[call]?.[parameter];
    if (value === undefined)
        return undefined;
    switch (value.kind) {
        case 'absent':
            return 'none';
        case 'bool':
        case 'number':
            return String(value.value);
        case 'string':
            return JSON.stringify(value.value);
        case 'colour':
            return hexOf(value.value);
        default:
            return `a ${value.kind}`;
    }
}
//# sourceMappingURL=defaults.js.map