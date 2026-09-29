import { standingIn } from './hours.js';
/** `HHMM-HHMM` with an optional `:` and a run of day digits. */
const SPEC = /^(\d{2})(\d{2})-(\d{2})(\d{2})(?::([1-7]{1,7}))?$/;
function parse(spec) {
    const parts = SPEC.exec(spec);
    if (parts === null)
        return null;
    const fromHour = Number(parts[1]);
    const fromMinute = Number(parts[2]);
    const toHour = Number(parts[3]);
    const toMinute = Number(parts[4]);
    // "2400" is midnight at the end of the day, and it is the one hour past 23
    // the spec allows.
    if (fromHour > 23 || fromMinute > 59 || toMinute > 59)
        return null;
    if (toHour > 24 || (toHour === 24 && toMinute !== 0))
        return null;
    const listed = parts[5];
    const days = listed === undefined ? null : [...listed].map((one) => Number(one));
    return { from: fromHour * 60 + fromMinute, to: toHour * 60 + toMinute, days };
}
/** Whether a bar's wall clock reading falls inside the hours a spec names. */
export function sessionHolds(spec, at) {
    if (spec === null || at === null)
        return null;
    const hours = parse(spec);
    if (hours === null)
        return null;
    return standingIn(hours, at).inside;
}
//# sourceMappingURL=spec.js.map