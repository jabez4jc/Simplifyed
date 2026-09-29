import { cssColour } from './colours.js';
import { colourField, stringField } from './fields.js';
/** The language's three positions, in the chart's own words. */
const POSITIONS = {
    above: 'aboveBar',
    below: 'belowBar',
    price: 'inBar',
};
/** The nine shapes both worlds spell the same way. */
const SHAPES = [
    'arrowUp',
    'arrowDown',
    'triangleUp',
    'triangleDown',
    'circle',
    'square',
    'diamond',
    'cross',
    'flag',
];
/** Which plate a `"label"` is: the tail points at the bar from where it sits. */
const PLATES = {
    aboveBar: 'labelDown',
    belowBar: 'labelUp',
    inBar: 'text',
};
/**
 * Every marker the run produced, oldest bar first.
 *
 * The bars are walked once per call site rather than once in total, so the
 * entries of one call site are contiguous; the sort afterwards is what puts the
 * whole set in bar order, and it is stable, so two call sites that marked one
 * bar stay in declaration order on it.
 */
export function buildMarkers(program, lookup, bars, columns, defaultColour) {
    const out = [];
    for (const declared of program.outputs.markers) {
        const style = styleOf(declared, lookup, defaultColour);
        const column = columns[declared.channel] ?? [];
        for (let index = 0; index < bars.length; index += 1) {
            const text = column[index];
            const bar = bars[index];
            if (typeof text !== 'string' || bar === undefined)
                continue;
            out.push({ index, marker: { ...style, time: bar.time, text } });
        }
    }
    return out.sort((a, b) => a.index - b.index).map((one) => one.marker);
}
/** The part of a marker that is declared once and is the same on every bar. */
function styleOf(declared, lookup, defaultColour) {
    const colour = colourField(declared.color, lookup);
    const written = stringField(declared.position, lookup, 'above');
    // A declaration a host cannot draw takes the default rather than stopping the
    // study: the compiler refuses an unknown one with OS3008, so a value arriving
    // here that is not in the set came from a hand edited program.
    const position = POSITIONS[written] ?? 'aboveBar';
    return {
        position,
        shape: shapeOf(stringField(declared.shape, lookup, 'label'), position),
        // The language has no marker size and the chart needs one, so every marker
        // is drawn at the size the chart's own studies use.
        size: 'small',
        // `signal`'s colour defaults to absence, which `stdlib.md` 14.3 reads as the
        // host's own default for a marker. The chart has no default of its own to
        // fall back to, so a host that has one states it.
        color: colour === undefined ? defaultColour : cssColour(colour),
    };
}
function shapeOf(written, position) {
    if (SHAPES.includes(written))
        return written;
    return PLATES[position];
}
//# sourceMappingURL=markers.js.map