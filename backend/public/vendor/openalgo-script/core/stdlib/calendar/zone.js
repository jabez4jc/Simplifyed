/**
 * The formatters, kept because building one is expensive and a study asks for
 * the same zone on every bar.
 *
 * This is memoisation and not state: the answer for a zone is the same answer
 * every time, nothing here is ever read back by a script, and clearing the map
 * between two bars would change how long a chart took and nothing else. No
 * state region holds any of it, so `compiled-program.md` section 2.11 has
 * nothing to copy.
 */
const FORMATTERS = new Map();
/**
 * An area and a location, or the one name that is neither.
 *
 * `stdlib.md` section 12.1 requires an area and location name and OS6005 says
 * in as many words that an abbreviation is not one, because several
 * abbreviations mean two different offsets in different parts of the world.
 * Runtimes disagree about which abbreviations they will quietly accept, so the
 * rule is applied here rather than left to whichever database is installed: a
 * script refused on one engine has to be refused on every engine. `UTC` is the
 * one name with no area, and it names one offset everywhere.
 */
const AREA_AND_LOCATION = /^[A-Za-z][A-Za-z0-9+_-]*\/[A-Za-z][A-Za-z0-9+_/-]*$/;
function formatterFor(zone) {
    const held = FORMATTERS.get(zone);
    if (held !== undefined)
        return held;
    if (zone !== 'UTC' && !AREA_AND_LOCATION.test(zone)) {
        FORMATTERS.set(zone, null);
        return null;
    }
    let made;
    try {
        made = new Intl.DateTimeFormat('en-US', {
            timeZone: zone,
            hourCycle: 'h23',
            era: 'short',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
    }
    catch {
        // An unknown zone name, which is OS6005 at the call rather than a guess
        // here. A name this runtime does not hold is not a name this engine can
        // invent an offset for.
        made = null;
    }
    FORMATTERS.set(zone, made);
    return made;
}
/** Whether the runtime's zone table holds this name. */
export function isKnownZone(zone) {
    return formatterFor(zone) !== null;
}
/** The civil fields an instant has in a zone, or nothing for an unknown zone. */
export function fieldsIn(instant, zone) {
    const formatter = formatterFor(zone);
    if (formatter === null || !Number.isFinite(instant))
        return null;
    const parts = formatter.formatToParts(new Date(instant));
    const found = {};
    for (const part of parts)
        found[part.type] = part.value;
    const year = Number(found['year']);
    const month = Number(found['month']);
    const day = Number(found['day']);
    const hour = Number(found['hour']);
    const minute = Number(found['minute']);
    const second = Number(found['second']);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day))
        return null;
    if (!Number.isFinite(hour) || !Number.isFinite(minute) || !Number.isFinite(second))
        return null;
    // Before the common era the year is counted backwards and 1 BC is year 0 on
    // the proleptic numbering the rest of this module uses.
    const era = found['era'];
    const signed = era === 'BC' || era === 'B' || era === 'BCE' ? 1 - year : year;
    return { year: signed, month, day, hour, minute, second };
}
/** The instant a civil date and time names in UTC, with no zone applied. */
export function utcInstantOf(fields) {
    const at = new Date(0);
    // `setUTCFullYear` rather than `Date.UTC`, which reads a two digit year as
    // nineteen hundred and something.
    at.setUTCFullYear(fields.year, fields.month - 1, fields.day);
    at.setUTCHours(fields.hour, fields.minute, fields.second, 0);
    return at.getTime();
}
/** How far ahead of UTC a zone was at an instant, in milliseconds. */
export function offsetAt(instant, zone) {
    const fields = fieldsIn(instant, zone);
    if (fields === null)
        return null;
    return utcInstantOf(fields) - instant;
}
/**
 * The instant a wall clock reading names in a zone.
 *
 * A reading is not an instant until a zone is applied, and the offset to apply
 * is the offset at the answer rather than at the reading, so this works the
 * other way round: it takes the two offsets the zone had a day either side,
 * builds the instant each one implies, and keeps the ones that read back as the
 * reading it was given.
 *
 * Two readings have no single answer and both are settled here rather than left
 * to an engine. **A reading the clock repeated**, the hour an autumn change
 * gives back, has two instants that read back correctly, and the answer is the
 * earlier of them: that is when a session opening at that clock time opens.
 * **A reading the clock skipped**, the hour a spring change removes, has none,
 * and the answer is the reading moved forward by the size of the gap, which is
 * where that hour would have been; absence there would put a hole in a study
 * one morning a year.
 */
export function instantOf(fields, zone) {
    const naive = utcInstantOf(fields);
    const day = 86_400_000;
    const before = offsetAt(naive - day, zone);
    const after = offsetAt(naive + day, zone);
    if (before === null || after === null)
        return null;
    let answer = null;
    for (const offset of before === after ? [before] : [before, after]) {
        const candidate = naive - offset;
        const actual = offsetAt(candidate, zone);
        if (actual === null || naive - actual !== candidate)
            continue;
        if (answer === null || candidate < answer)
            answer = candidate;
    }
    // No candidate reads back: the reading is inside a gap the clock skipped, and
    // the offset in force before it is the one that moves it past the gap.
    return answer ?? naive - before;
}
//# sourceMappingURL=zone.js.map