import { dayNumber, weekdayOfDay } from '../../stdlib/index.js';
/** Minutes in a day, so the wrap is named rather than written as a number. */
const DAY = 1440;
const OUTSIDE = { inside: false, elapsed: 0, remaining: 0, openingDay: 0 };
/** Where a wall clock reading sits in a range of hours, or outside every one. */
export function standingIn(hours, at) {
    const minutes = at.hour * 60 + at.minute + at.second / 60;
    const today = dayNumber(at.year, at.month, at.day);
    if (hours.to > hours.from) {
        if (minutes < hours.from || minutes >= hours.to)
            return OUTSIDE;
        return held(hours, today, minutes - hours.from, hours.to - minutes);
    }
    if (hours.to === hours.from)
        return OUTSIDE;
    // Crossing midnight: the evening part belongs to today's session and the
    // morning part to yesterday's, which is the day the list is read against.
    if (minutes >= hours.from) {
        return held(hours, today, minutes - hours.from, DAY - minutes + hours.to);
    }
    if (minutes < hours.to) {
        return held(hours, today - 1, DAY - hours.from + minutes, hours.to - minutes);
    }
    return OUTSIDE;
}
function held(hours, openingDay, elapsed, remaining) {
    if (hours.days !== null && !hours.days.includes(weekdayOfDay(openingDay)))
        return OUTSIDE;
    return { inside: true, elapsed, remaining, openingDay };
}
//# sourceMappingURL=hours.js.map