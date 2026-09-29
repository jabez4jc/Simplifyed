/**
 * The engine's library manifest: what a `CALL_LIB` can name, and what each
 * entry does.
 *
 * `compiled-program.md` 2.5 gives this table its job. A compiled program
 * carries its own copy of every function it calls, with the name, the argument
 * count, whether the function holds state and what effect it has, and at load
 * the engine compares each entry against this one. A mismatch is OS6004, and
 * the entries carry facts the engine already knows precisely so that they can
 * be disagreed with: it catches a program compiled against a newer library
 * before it computes a single wrong number.
 *
 * **A name this engine does not implement is refused at load, not at the call.**
 * The alternative, discovering it halfway through bar nine thousand, would give
 * a user a broken chart and a message about a function rather than a message
 * before anything was drawn.
 *
 * The table is keyed by name and argument count, because the library has names
 * with more than one signature: `text` takes one value or a value and a digit
 * count, and `min` takes two numbers or one array. The one pair that shares a
 * name **and** a count is `clear`, which empties an array or a grid, and the
 * engine tells those apart by asking the heap what the handle points at.
 */
import { ARRAY_ENTRIES } from './arrays.js';
import { AVERAGE_ENTRIES } from './averages.js';
import { CHART_ENTRIES } from './chart.js';
import { COLOUR_ENTRIES } from './colours.js';
import { DATE_ENTRIES } from './dates.js';
import { MATHS_ENTRIES } from './maths.js';
import { OBJECT_ENTRIES } from './objects.js';
import { OSCILLATOR_ENTRIES } from './oscillators.js';
import { RANGE_ENTRIES } from './ranges.js';
import { SERIES_ENTRIES } from './series.js';
import { STUDY_ENTRIES } from './studies.js';
import { TEXT_ENTRIES } from './text.js';
import { TREND_ENTRIES } from './trend.js';
import { VOLUME_ENTRIES } from './volume.js';
/**
 * The two string rules, for the operators outside this module and the tests:
 * `code-points.ts` says why neither is the host's own.
 */
export { compareStrings, isWhitespace, trimmed } from './code-points.js';
const ENTRIES = [
    ...COLOUR_ENTRIES,
    ...MATHS_ENTRIES,
    ...TEXT_ENTRIES,
    ...ARRAY_ENTRIES,
    ...SERIES_ENTRIES,
    ...AVERAGE_ENTRIES,
    ...STUDY_ENTRIES,
    ...TREND_ENTRIES,
    ...OSCILLATOR_ENTRIES,
    ...RANGE_ENTRIES,
    ...VOLUME_ENTRIES,
    ...OBJECT_ENTRIES,
    ...CHART_ENTRIES,
    ...DATE_ENTRIES,
];
function keyOf(name, arity) {
    return `${name}/${arity}`;
}
const INDEX = new Map();
const ARITIES = new Map();
for (const one of ENTRIES) {
    INDEX.set(keyOf(one.name, one.arity), one);
    const known = ARITIES.get(one.name);
    if (known === undefined)
        ARITIES.set(one.name, [one.arity]);
    else
        known.push(one.arity);
}
/** The entry for one name and argument count, or nothing when there is none. */
/**
 * Every name and argument count this engine holds, as `name/arity`, sorted.
 *
 * `scripts/check-manifests.mjs` compares it with the second engine's, so a call
 * one engine holds and the other does not is found by a build rather than by the
 * first case that reaches it.
 */
export function manifestKeys() {
    return [...INDEX.keys()].sort();
}
export function manifestEntry(name, arity) {
    return INDEX.get(keyOf(name, arity));
}
/** What this engine has under a name, for OS6004's message. */
export function manifestSays(name) {
    const arities = ARITIES.get(name);
    if (arities === undefined)
        return `no function called ${name}`;
    const counts = [...arities].sort((a, b) => a - b).join(' or ');
    return `${name} with ${counts} argument${arities.length === 1 && arities[0] === 1 ? '' : 's'}`;
}
/** Every entry, for the test that compares this table with the checker's. */
export function manifestEntries() {
    return ENTRIES;
}
export { copyState } from './state.js';
export { COLOUR_NAMES, namedColour } from './colours.js';
export { spell } from './text.js';
//# sourceMappingURL=index.js.map