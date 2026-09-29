import { dayNumber, weekdayOfDay } from './civil.js';
const MONTHS = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** The placeholders, longest first, which is the order the scan tries them in. */
const PLACEHOLDERS = ['yyyy', 'MMM', 'EEE', 'MM', 'dd', 'HH', 'mm', 'ss'];
function pad(value, width) {
    const digits = Math.abs(Math.trunc(value)).toString();
    const padded = digits.length >= width ? digits : '0'.repeat(width - digits.length) + digits;
    return value < 0 ? `-${padded}` : padded;
}
function substitution(token, fields) {
    switch (token) {
        case 'yyyy':
            return pad(fields.year, 4);
        case 'MMM':
            return MONTHS[fields.month - 1] ?? '';
        case 'EEE':
            return WEEKDAYS[weekdayOfDay(dayNumber(fields.year, fields.month, fields.day)) - 1] ?? '';
        case 'MM':
            return pad(fields.month, 2);
        case 'dd':
            return pad(fields.day, 2);
        case 'HH':
            return pad(fields.hour, 2);
        case 'mm':
            return pad(fields.minute, 2);
        default:
            return pad(fields.second, 2);
    }
}
/** A pattern rendered against one civil reading, or nothing when there is none. */
export function renderPattern(pattern, fields) {
    if (pattern === null || fields === null)
        return null;
    let out = '';
    let at = 0;
    while (at < pattern.length) {
        const token = PLACEHOLDERS.find((one) => pattern.startsWith(one, at));
        if (token === undefined) {
            out += pattern[at];
            at += 1;
            continue;
        }
        out += substitution(token, fields);
        at += token.length;
    }
    return out;
}
//# sourceMappingURL=format.js.map