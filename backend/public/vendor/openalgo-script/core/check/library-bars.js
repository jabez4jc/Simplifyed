/**
 * The part of the library that reads a bar, an instrument, a clock or a string:
 * `stdlib.md` sections 3, 8.2, 10 and 12, plus the nineteen colour names of
 * section 11.1.
 *
 * Nothing here computes across bars, so nothing here has a warmup of its own.
 * The two exceptions state theirs: a session's start and end are known from the
 * session's first bar, which is a fact about the data rather than a length.
 */
import { DATA_DRIVEN, entry } from './library.js';
/** The colour names of stdlib.md 11.1, each an ordinary global of type `color`. */
export const COLOUR_NAMES = [
    'aqua',
    'black',
    'blue',
    'brown',
    'fuchsia',
    'gray',
    'green',
    'lime',
    'maroon',
    'navy',
    'olive',
    'orange',
    'pink',
    'purple',
    'red',
    'silver',
    'teal',
    'white',
    'yellow',
];
/** The built-in series of stdlib.md 3.1, the only names with a bar's history. */
export const BAR_SERIES = [
    'open',
    'high',
    'low',
    'close',
    'volume',
    'hl2',
    'hlc3',
    'ohlc4',
    'hlcc4',
    'oi',
    'time',
];
const colours = COLOUR_NAMES.map((name) => entry(`${name} -> color`));
const series = [
    ...BAR_SERIES.map((name) => entry(`${name} -> series number`)),
    entry('timeClose -> series number', { planned: true }),
];
const bar = [
    entry('bar.index -> series number'),
    entry('bar.count -> series number'),
    entry('bar.isFirst -> series bool'),
    entry('bar.isLast -> series bool'),
    entry('bar.isConfirmed -> series bool'),
    entry('bar.isRealtime -> series bool'),
    entry('bar.isNew -> series bool'),
    entry('bar.updates -> series number'),
];
const chart = [
    entry('chart.symbol -> string'),
    entry('chart.exchange -> string'),
    entry('chart.interval -> string'),
    entry('chart.intervalMinutes -> number'),
    entry('chart.isIntraday -> bool'),
    entry('chart.timezone -> string'),
    entry('chart.tickSize -> number'),
    entry('chart.lotSize -> number'),
    entry('chart.pointValue -> number'),
    entry('chart.currency -> string'),
    entry('chart.instrumentType -> string'),
    entry('chart.hasVolume -> bool'),
    entry('chart.hasOpenInterest -> bool'),
    entry('chart.now() -> number'),
    entry('chart.isReplay -> bool', { planned: true }),
    entry('chart.expiry -> number', { planned: true }),
    entry('chart.strike -> number', { planned: true }),
    entry('chart.optionType -> string', { planned: true }),
];
/**
 * The session facts, `stdlib.md` 12.4.
 *
 * **Three run and the rest are planned**, and the line between them is what an
 * engine can answer today. `session.isFirstBar` and `session.isLastBar` are
 * derived from the session hours in the instrument record
 * (`host-interface.md` 4.3), the bar's time and the instrument's timezone.
 * `session.isIn` reads the hours the script itself wrote, and the calendar of
 * section 12.2 turns them into a test. The rest read the same hours and want
 * an instant or a count off it rather than a boundary, so they are marked
 * rather than left to be refused at load with a message about a function.
 */
const session = [
    entry('session.isOpen -> series bool', { planned: true }),
    entry('session.isFirstBar -> series bool'),
    entry('session.isLastBar -> series bool'),
    entry('session.startTime -> series number', { planned: true, warmup: DATA_DRIVEN }),
    entry('session.endTime -> series number', { planned: true, warmup: DATA_DRIVEN }),
    entry('session.barIndex -> series number', { planned: true }),
    entry('session.isIn(spec: string, zone?: string = chart.timezone) -> series bool'),
    entry('session.isHoliday(t: number) -> bool', { planned: true }),
    entry('session.nextOpen -> series number', { planned: true }),
];
/**
 * The calendar, `stdlib.md` 12.2.
 *
 * Every entry reads a timestamp in a named zone, and the zone table is the
 * runtime's own rather than one copied here: `calendar/zone.ts` gives the
 * reason. `date.add` stays planned because calendar arithmetic that respects
 * month lengths has a rule to settle first, which the entry itself says.
 */
const date = [
    entry('date.year(t: number, zone?: string = chart.timezone) -> number'),
    entry('date.month(t: number, zone?: string = chart.timezone) -> number'),
    entry('date.day(t: number, zone?: string = chart.timezone) -> number'),
    entry('date.dayOfWeek(t: number, zone?: string = chart.timezone) -> number'),
    entry('date.dayOfYear(t: number, zone?: string = chart.timezone) -> number'),
    entry('date.hour(t: number, zone?: string = chart.timezone) -> number'),
    entry('date.minute(t: number, zone?: string = chart.timezone) -> number'),
    entry('date.second(t: number, zone?: string = chart.timezone) -> number'),
    entry('date.weekOfYear(t: number, zone?: string = chart.timezone) -> number'),
    entry('date.from(year: number, month: number, day: number, hour?: number = 0, minute?: number = 0, second?: number = 0, zone?: string = chart.timezone) -> number'),
    entry('date.startOfDay(t: number, zone?: string = chart.timezone) -> number'),
    entry('date.startOfWeek(t: number, zone?: string = chart.timezone) -> number'),
    entry('date.startOfMonth(t: number, zone?: string = chart.timezone) -> number'),
    entry('date.isSameDay(a: number, b: number, zone?: string = chart.timezone) -> bool'),
    entry('date.format(t: number, pattern: string, zone?: string = chart.timezone) -> string'),
    entry('date.add(t: number, unit: string, count: number, zone?: string = chart.timezone) -> number', {
        planned: true,
    }),
];
const maths = [
    entry('math.pi -> number'),
    entry('math.e -> number'),
    entry('math.log2(x: number) -> number'),
    entry('math.hypot(x: number, y: number) -> number'),
    entry('math.toDegrees(x: number) -> number'),
    entry('math.toRadians(x: number) -> number'),
    entry('math.sin(x: number) -> number'),
    entry('math.cos(x: number) -> number'),
    entry('math.tan(x: number) -> number'),
    entry('math.asin(x: number) -> number'),
    entry('math.acos(x: number) -> number'),
    entry('math.atan(x: number) -> number'),
    entry('math.atan2(y: number, x: number) -> number'),
    entry('math.sinh(x: number) -> number', { planned: true }),
    entry('math.cosh(x: number) -> number', { planned: true }),
    entry('math.tanh(x: number) -> number', { planned: true }),
];
const strings = [
    entry('str.length(s: string) -> number'),
    entry('str.upper(s: string) -> string'),
    entry('str.lower(s: string) -> string'),
    entry('str.trim(s: string) -> string'),
    entry('str.contains(s: string, part: string) -> bool'),
    entry('str.startsWith(s: string, part: string) -> bool'),
    entry('str.endsWith(s: string, part: string) -> bool'),
    entry('str.indexOf(s: string, part: string) -> number'),
    entry('str.substring(s: string, from: number, to?: number = none) -> string'),
    entry('str.replace(s: string, find: string, with: string) -> string'),
    entry('str.replaceAll(s: string, find: string, with: string) -> string'),
    entry('str.split(s: string, separator: string) -> array<string>'),
    entry('str.join(parts: array<string>, separator: string) -> string'),
    entry('str.padLeft(s: string, width: number, fill?: string = " ") -> string'),
    entry('str.padRight(s: string, width: number, fill?: string = " ") -> string'),
    entry('str.repeat(s: string, n: number) -> string'),
    entry('str.format(template: string, values: array<string>) -> string', { planned: true }),
    entry('str.match(s: string, pattern: string) -> bool', { planned: true }),
];
export const BAR_ENTRIES = [
    ...colours,
    ...series,
    ...bar,
    ...chart,
    ...session,
    ...date,
    ...maths,
    ...strings,
];
//# sourceMappingURL=library-bars.js.map