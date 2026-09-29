/**
 * Calendar arithmetic on civil dates: no zone, no instant, no clock.
 *
 * A civil date is a year, a month and a day as a person writes them. Turning
 * one into an instant needs a zone and lives in `zone.ts`; everything here is
 * counting days, and it is separated for that reason: the day number of the
 * fifteenth of March is the same fact in every zone on earth, and mixing the
 * two questions is how a calendar ends up right in one half of the year.
 *
 * The day number is days since 1970-01-01, positive after it and negative
 * before. The conversion both ways is the standard proleptic Gregorian one,
 * shifted so the leap day falls at the end of an internal year that starts in
 * March: that is what removes the special case for February and makes the
 * inverse exact rather than iterative.
 */
/** Days from 1970-01-01 to this civil date. */
export function dayNumber(year, month, day) {
    const shifted = month <= 2 ? year - 1 : year;
    // A floor division, and nothing added to it: the published form subtracts 399
    // from a negative year so that a truncating division floors, and this one
    // already does. Doing both put every date before about 1 BCE one day early.
    const era = Math.floor(shifted / 400);
    const yearOfEra = shifted - era * 400;
    const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
    const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
    return era * 146097 + dayOfEra - 719468;
}
/** The civil date a day number names, the exact inverse of `dayNumber`. */
export function dateOfDay(days) {
    const shifted = days + 719468;
    const era = Math.floor(shifted / 146097);
    const dayOfEra = shifted - era * 146097;
    const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365);
    const year = yearOfEra + era * 400;
    const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
    const monthPart = Math.floor((5 * dayOfYear + 2) / 153);
    const day = dayOfYear - Math.floor((153 * monthPart + 2) / 5) + 1;
    const month = monthPart + (monthPart < 10 ? 3 : -9);
    return { year: month <= 2 ? year + 1 : year, month, day };
}
/**
 * The day of the week, 1 for Monday through 7 for Sunday.
 *
 * Monday is 1 so that a weekday test reads `date.dayOfWeek(time) <= 5` and a
 * trading week is a contiguous range, which `stdlib.md` section 12.2 states and
 * gives the reason for.
 */
export function weekdayOfDay(days) {
    // 1970-01-01 was a Thursday, which is 4 on this numbering.
    const shifted = (days + 3) % 7;
    return (shifted < 0 ? shifted + 7 : shifted) + 1;
}
/** The day of the year, 1 to 366. */
export function dayOfYearOf(year, month, day) {
    return dayNumber(year, month, day) - dayNumber(year, 1, 1) + 1;
}
/**
 * The week number, weeks starting Monday.
 *
 * Read as the ISO 8601 week: week 1 is the week holding the year's first
 * Thursday, so a week that straddles the new year belongs to the year holding
 * most of it and no year ever has a week 0. `stdlib.md` section 12.2 fixes the
 * Monday start and this settles the rest of it, because the alternatives differ
 * by a whole week at the turn of every year and a reader has no way to tell
 * which one a chart drew.
 */
export function weekOfYearOf(year, month, day) {
    const days = dayNumber(year, month, day);
    const thursday = days + (4 - weekdayOfDay(days));
    const owner = dateOfDay(thursday).year;
    return Math.floor((thursday - dayNumber(owner, 1, 1)) / 7) + 1;
}
//# sourceMappingURL=civil.js.map