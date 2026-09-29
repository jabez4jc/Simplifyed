/**
 * The part of the library that computes: `stdlib.md` sections 4 to 11 and the
 * array operations of `language.md` 14.1.
 *
 * Every entry carries the warmup its row in `stdlib.md` states. Where the
 * formula there is longer than the shape this module can hold, the entry is
 * marked inexact and the checker reports a floor rather than a number, because
 * a warmup that is stated exactly and is wrong would be worse than one that
 * says it is a bound. `atLeastLength` is that mark.
 */
import { DATA_DRIVEN, TOTAL, atLeastLength, delayBars, entry, fromLength, fromLengths, wholeRange, } from './library.js';
const stateful = { stateful: true };
/**
 * `[gap, signal, histogram]`, which two entries return on the same terms.
 *
 * The gap is there once the slower mean is, and the signal and the histogram
 * wait for the mean of the gap: `slow + signal - 2`, the bar `stdlib.md` states
 * for both of them.
 */
const GAP_AND_SIGNAL = [
    fromLength('slow', -1),
    fromLengths(['slow', 'signal'], -2),
    fromLengths(['slow', 'signal'], -2),
];
/** The three colour channels of stdlib.md 11.2, which are whole 0 to 255. */
const CHANNELS = { r: wholeRange(0, 255), g: wholeRange(0, 255), b: wholeRange(0, 255) };
const trend = [
    entry('sma(src: series number, len: number) -> series number', {
        ...stateful,
        warmup: fromLength('len', -1),
    }),
    entry('ema(src: series number, len: number) -> series number', {
        ...stateful,
        warmup: fromLength('len', -1),
    }),
    entry('wma(src: series number, len: number) -> series number', {
        ...stateful,
        warmup: fromLength('len', -1),
    }),
    entry('rma(src: series number, len: number) -> series number', {
        ...stateful,
        warmup: fromLength('len', -1),
    }),
    entry('hma(src: series number, len: number) -> series number', {
        ...stateful,
        warmup: atLeastLength(['len'], -2),
    }),
    entry('dema(src: series number, len: number) -> series number', {
        ...stateful,
        warmup: fromLength('len', -2, 2),
    }),
    entry('tema(src: series number, len: number) -> series number', {
        ...stateful,
        warmup: fromLength('len', -3, 3),
    }),
    entry('vwma(src: series number, len: number) -> series number', {
        ...stateful,
        warmup: fromLength('len', -1),
    }),
    entry('swma(src: series number) -> series number', { ...stateful, warmup: delayBars(3) }),
    entry('alma(src: series number, len: number, offset?: number = 0.85, sigma?: number = 6) -> series number', { ...stateful, warmup: fromLength('len', -1) }),
    entry('linreg(src: series number, len: number, offset?: number = 0) -> series number', {
        ...stateful,
        warmup: fromLength('len', -1),
    }),
    entry('ma(src: series number, len: number, type?: string = "sma") -> series number', {
        ...stateful,
        warmup: atLeastLength(['len'], -1),
        values: { type: ['sma', 'ema', 'wma', 'rma', 'hma', 'vwma'] },
    }),
    entry('supertrend(factor?: number = 3, atrLen?: number = 10) -> array<number>', {
        ...stateful,
        warmup: fromLength('atrLen', 0),
    }),
    entry('psar(start?: number = 0.02, step?: number = 0.02, max?: number = 0.2) -> array<number>', {
        ...stateful,
        warmup: delayBars(1),
    }),
    entry('adx(diLen?: number = 14, adxLen?: number = 14) -> array<number>', {
        ...stateful,
        warmup: atLeastLength(['diLen'], 0),
        elements: [
            fromLengths(['diLen', 'adxLen'], -1),
            fromLength('diLen', 0),
            fromLength('diLen', 0),
        ],
    }),
    entry('aroon(len?: number = 14) -> array<number>', { ...stateful, warmup: fromLength('len', 0) }),
    entry('ichimoku(convLen?: number = 9, baseLen?: number = 26, spanLen?: number = 52) -> array<number>', {
        ...stateful,
        warmup: atLeastLength(['convLen'], -1),
        elements: [
            fromLength('convLen', -1),
            fromLength('baseLen', -1),
            fromLength('baseLen', -1),
            fromLength('spanLen', -1),
            fromLength('baseLen', -1),
        ],
    }),
    entry('kama(src: series number, len: number, fast?: number = 2, slow?: number = 30) -> series number', {
        planned: true,
    }),
    entry('zlema(src: series number, len: number) -> series number', { planned: true }),
    entry('vidya(src: series number, len: number) -> series number', { planned: true }),
    entry('zigzag(src: series number, deviation: number) -> array<number>', { planned: true }),
];
const momentum = [
    entry('rsi(src: series number, len?: number = 14) -> series number', {
        ...stateful,
        warmup: fromLength('len', 0),
    }),
    entry('stoch(len?: number = 14, smoothK?: number = 1, smoothD?: number = 3) -> array<number>', {
        ...stateful,
        warmup: atLeastLength(['len', 'smoothK'], -2),
        elements: [
            fromLengths(['len', 'smoothK'], -2),
            fromLengths(['len', 'smoothK', 'smoothD'], -3),
        ],
    }),
    entry('stochRsi(src: series number, rsiLen?: number = 14, stochLen?: number = 14, smoothK?: number = 3, smoothD?: number = 3) -> array<number>', {
        ...stateful,
        warmup: atLeastLength(['rsiLen', 'stochLen', 'smoothK'], -2),
        // One element and not two: `stdlib.md` states the bar for element 0 and
        // not for the line smoothed out of it, and element 1 takes the entry's
        // own floor rather than a formula nobody wrote down.
        elements: [fromLengths(['rsiLen', 'stochLen', 'smoothK'], -2)],
    }),
    entry('macd(src: series number, fast?: number = 12, slow?: number = 26, signal?: number = 9) -> array<number>', { ...stateful, warmup: fromLength('slow', -1), elements: GAP_AND_SIGNAL }),
    entry('ppo(src: series number, fast?: number = 12, slow?: number = 26, signal?: number = 9) -> array<number>', { ...stateful, warmup: fromLength('slow', -1), elements: GAP_AND_SIGNAL }),
    entry('cci(len?: number = 20) -> series number', { ...stateful, warmup: fromLength('len', -1) }),
    entry('mom(src: series number, len?: number = 10) -> series number', {
        ...stateful,
        warmup: fromLength('len', 0),
    }),
    entry('roc(src: series number, len?: number = 9) -> series number', {
        ...stateful,
        warmup: fromLength('len', 0),
    }),
    entry('williamsR(len?: number = 14) -> series number', {
        ...stateful,
        warmup: fromLength('len', -1),
    }),
    entry('tsi(src: series number, longLen?: number = 25, shortLen?: number = 13) -> series number', {
        ...stateful,
        warmup: atLeastLength(['longLen', 'shortLen'], -1),
    }),
    entry('trix(src: series number, len?: number = 18) -> series number', {
        ...stateful,
        warmup: fromLength('len', -2, 3),
    }),
    entry('cmo(src: series number, len?: number = 9) -> series number', {
        ...stateful,
        warmup: fromLength('len', 0),
    }),
    entry('dpo(src: series number, len?: number = 21) -> series number', {
        ...stateful,
        warmup: atLeastLength(['len'], 0),
    }),
    entry('ultimateOsc(len1?: number = 7, len2?: number = 14, len3?: number = 28) -> series number', {
        ...stateful,
        warmup: atLeastLength(['len1'], 0),
    }),
    entry('awesomeOsc(fast?: number = 5, slow?: number = 34) -> series number', {
        ...stateful,
        warmup: fromLength('slow', -1),
    }),
    entry('fisher(len?: number = 9) -> array<number>', { planned: true }),
    entry('rvi(src: series number, len?: number = 10) -> array<number>', { planned: true }),
    entry('coppock(src: series number, roc1?: number = 14, roc2?: number = 11, wmaLen?: number = 10) -> series number', { planned: true }),
];
const volatility = [
    entry('trueRange() -> series number'),
    entry('atr(len?: number = 14) -> series number', { ...stateful, warmup: fromLength('len', -1) }),
    entry('natr(len?: number = 14) -> series number', { ...stateful, warmup: fromLength('len', -1) }),
    entry('stdev(src: series number, len: number, sample?: bool = false) -> series number', {
        ...stateful,
        warmup: fromLength('len', -1),
    }),
    entry('variance(src: series number, len: number, sample?: bool = false) -> series number', {
        ...stateful,
        warmup: fromLength('len', -1),
    }),
    entry('bollinger(src: series number, len?: number = 20, mult?: number = 2) -> array<number>', {
        ...stateful,
        warmup: fromLength('len', -1),
    }),
    entry('bbWidth(src: series number, len?: number = 20, mult?: number = 2) -> series number', {
        ...stateful,
        warmup: fromLength('len', -1),
    }),
    entry('bbPercent(src: series number, len?: number = 20, mult?: number = 2) -> series number', {
        ...stateful,
        warmup: fromLength('len', -1),
    }),
    entry('keltner(len?: number = 20, mult?: number = 2, atrLen?: number = 10, maType?: string = "ema") -> array<number>', { ...stateful, warmup: atLeastLength(['len'], -1) }),
    entry('donchian(len?: number = 20) -> array<number>', {
        ...stateful,
        warmup: fromLength('len', -1),
    }),
    entry('chop(len?: number = 14) -> series number', { ...stateful, warmup: fromLength('len', 0) }),
    entry('hv(src: series number, len?: number = 20, periodsPerYear?: number = 252) -> series number', {
        ...stateful,
        warmup: fromLength('len', 0),
    }),
    entry('massIndex(len?: number = 25) -> series number', { planned: true }),
];
const volume = [
    entry('vwap(src?: series number = hlc3) -> series number', { ...stateful, warmup: DATA_DRIVEN }),
    entry('vwapAnchor(src: series number, resetWhen: series bool) -> series number', {
        ...stateful,
        warmup: DATA_DRIVEN,
    }),
    entry('obv() -> series number', stateful),
    entry('ad() -> series number', stateful),
    entry('adOsc(fast?: number = 3, slow?: number = 10) -> series number', {
        ...stateful,
        warmup: fromLength('slow', -1),
    }),
    entry('mfi(len?: number = 14) -> series number', { ...stateful, warmup: fromLength('len', 0) }),
    entry('cmf(len?: number = 20) -> series number', { ...stateful, warmup: fromLength('len', -1) }),
    entry('pvt() -> series number', { ...stateful, warmup: delayBars(1) }),
    entry('eom(len?: number = 14) -> series number', { ...stateful, warmup: fromLength('len', 0) }),
    entry('forceIndex(len?: number = 13) -> series number', {
        ...stateful,
        warmup: fromLength('len', 0),
    }),
    entry('relativeVolume(len?: number = 20) -> series number', {
        ...stateful,
        warmup: fromLength('len', -1),
    }),
    entry('nvi() -> series number', { planned: true }),
    entry('pvi() -> series number', { planned: true }),
    entry('klinger(fast?: number = 34, slow?: number = 55, signal?: number = 13) -> array<number>', {
        planned: true,
    }),
    entry('volumeProfile(rows?: number = 24, from?: number = none) -> array<number>', { planned: true }),
    entry('cvd() -> series number', { planned: true }),
];
const helpers = [
    entry('highest(src: series number, len: number) -> series number', {
        ...stateful,
        warmup: fromLength('len', -1),
    }),
    entry('lowest(src: series number, len: number) -> series number', {
        ...stateful,
        warmup: fromLength('len', -1),
    }),
    entry('highestBars(src: series number, len: number) -> series number', {
        ...stateful,
        warmup: fromLength('len', -1),
    }),
    entry('lowestBars(src: series number, len: number) -> series number', {
        ...stateful,
        warmup: fromLength('len', -1),
    }),
    entry('change(src: series number) -> series number', { ...stateful, warmup: delayBars(1) }),
    entry('change(src: series number, len: number) -> series number', {
        ...stateful,
        warmup: fromLength('len', 0),
    }),
    entry('rising(src: series number, len: number) -> series bool', {
        ...stateful,
        warmup: fromLength('len', 0),
    }),
    entry('falling(src: series number, len: number) -> series bool', {
        ...stateful,
        warmup: fromLength('len', 0),
    }),
    entry('crossUp(a: series number, b: series number) -> series bool', {
        ...stateful,
        warmup: delayBars(1),
    }),
    entry('crossDown(a: series number, b: series number) -> series bool', {
        ...stateful,
        warmup: delayBars(1),
    }),
    entry('cross(a: series number, b: series number) -> series bool', {
        ...stateful,
        warmup: delayBars(1),
    }),
    entry('barsSince(cond: series bool) -> series number', { ...stateful, warmup: DATA_DRIVEN }),
    entry('valueWhen(cond: series bool, src: T, occurrence?: number = 0) -> T', {
        ...stateful,
        warmup: DATA_DRIVEN,
    }),
    entry('cum(src: series number) -> series number', stateful),
    entry('sum(src: series number, len: number) -> series number', {
        ...stateful,
        warmup: fromLength('len', -1),
    }),
    entry('count(cond: series bool, len: number) -> series number', {
        ...stateful,
        warmup: fromLength('len', -1),
    }),
    entry('sumSkip(src: series number, len: number) -> series number', {
        ...stateful,
        warmup: fromLength('len', -1),
    }),
    entry('avgSkip(src: series number, len: number) -> series number', {
        ...stateful,
        warmup: fromLength('len', -1),
    }),
    entry('countPresent(src: series number, len: number) -> series number', {
        ...stateful,
        warmup: fromLength('len', -1),
    }),
    entry('history(src: T, n: number) -> T', { ...stateful, warmup: fromLength('n', 0) }),
    entry('pivotHigh(src: series number, left: number, right: number) -> series number', {
        ...stateful,
        warmup: fromLengths(['left', 'right'], 0),
    }),
    entry('pivotLow(src: series number, left: number, right: number) -> series number', {
        ...stateful,
        warmup: fromLengths(['left', 'right'], 0),
    }),
    entry('median(src: series number, len: number) -> series number', {
        ...stateful,
        warmup: fromLength('len', -1),
    }),
    entry('percentile(src: series number, len: number, p: number) -> series number', {
        ...stateful,
        warmup: fromLength('len', -1),
    }),
    entry('percentRank(src: series number, len: number) -> series number', {
        ...stateful,
        warmup: fromLength('len', -1),
    }),
    entry('correlation(a: series number, b: series number, len: number) -> series number', {
        ...stateful,
        warmup: fromLength('len', -1),
    }),
    entry('covariance(a: series number, b: series number, len: number) -> series number', {
        ...stateful,
        warmup: fromLength('len', -1),
    }),
];
const maths = [
    entry('abs(x: number) -> number'),
    entry('sign(x: number) -> number'),
    entry('min(a: number, b: number) -> number'),
    entry('max(a: number, b: number) -> number'),
    entry('clamp(x: number, lo: number, hi: number) -> number'),
    entry('floor(x: number) -> number'),
    entry('ceil(x: number) -> number'),
    entry('round(x: number) -> number'),
    entry('round(x: number, decimals: number) -> number'),
    entry('trunc(x: number) -> number'),
    entry('roundToStep(x: number, step: number) -> number'),
    entry('roundToTick(price: number) -> number'),
    entry('sqrt(x: number) -> number'),
    entry('pow(x: number, y: number) -> number'),
    entry('exp(x: number) -> number'),
    entry('log(x: number) -> number'),
    entry('log10(x: number) -> number'),
    entry('mod(a: number, b: number) -> number'),
    entry('isNone(x: any) -> bool', { warmup: TOTAL }),
    entry('orElse(x: T, fallback: T) -> T', {
        warmup: { kind: 'either', params: ['x', 'fallback'] },
    }),
    // The three conversions. Two of them are spelled `to` and the type because
    // `bool` and `number` are reserved words: a call has a name in front of it,
    // a reserved word is not one, and a library that published those two spellings
    // published two names no script could ever write. `text` is not the odd one
    // out: `text` is not a type name either, the type is `string`, and the same
    // call is the formatter as well (`text(x, 2)`), so it never collided and it
    // keeps the name every script already writes.
    entry('toBool(x: any) -> bool', { warmup: TOTAL }),
    entry('text(x: any) -> string'),
    entry('text(x: number, decimals: number) -> string'),
    entry('toNumber(s: string) -> number'),
];
const colour = [
    entry('rgb(r: number, g: number, b: number) -> color', { whole: CHANNELS }),
    entry('rgba(r: number, g: number, b: number, a: number) -> color', { whole: CHANNELS }),
    entry('fade(color: color, percent: number) -> color'),
    entry('mix(a: color, b: color, weight: number) -> color'),
    entry('alpha(color: color) -> number'),
    entry('withAlpha(color: color, a: number) -> color'),
    entry('hsl(h: number, s: number, l: number) -> color', { planned: true }),
    entry('gradient(value: number, from: number, to: number, colorFrom: color, colorTo: color) -> color', { planned: true }),
];
const arrays = [
    entry('size(arr: array<E>) -> number'),
    entry('element(arr: array<E>, i: number) -> E'),
    entry('set(arr: array<E>, i: number, v: E) -> nothing'),
    entry('push(arr: array<E>, v: E) -> nothing'),
    entry('pop(arr: array<E>) -> E'),
    entry('shift(arr: array<E>) -> E'),
    entry('unshift(arr: array<E>, v: E) -> nothing'),
    entry('insert(arr: array<E>, i: number, v: E) -> nothing'),
    entry('remove(arr: array<E>, i: number) -> E'),
    entry('clear(arr: array<E>) -> nothing'),
    entry('slice(arr: array<E>, from: number, to: number) -> array<E>'),
    entry('copy(arr: array<E>) -> array<E>'),
    entry('indexOf(arr: array<E>, v: E) -> number'),
    entry('arrayEqual(a: array<E>, b: array<E>) -> bool'),
    entry('sort(arr: array<E>, order: string) -> nothing', { values: { order: ['asc', 'desc'] } }),
    entry('reverse(arr: array<E>) -> nothing'),
    entry('sum(arr: array<number>) -> number'),
    entry('avg(arr: array<number>) -> number'),
    entry('min(arr: array<number>) -> number'),
    entry('max(arr: array<number>) -> number'),
    entry('stdev(arr: array<number>) -> number'),
];
export const SERIES_ENTRIES = [
    ...trend,
    ...momentum,
    ...volatility,
    ...volume,
    ...helpers,
    ...maths,
    ...colour,
    ...arrays,
];
//# sourceMappingURL=library-series.js.map