/**
 * Every built-in the importer translates, and what it becomes.
 *
 * This table is the one statement of that mapping. The importer reads it, and
 * the documentation page's table is compared with it row for row by
 * `tests/importer/table.test.ts`, so the page cannot teach a mapping the
 * importer does not make. A built-in with no row here is refused with OS9003
 * rather than guessed at.
 *
 * `difference` says how far a translation can be trusted, and it is the reason
 * a row exists at all rather than a remark about it:
 *
 *   - `exact`: the OpenScript call computes the same value on every bar where
 *     the source's value is finite, absent bars included, or the importer
 *     writes the expression that does. An OpenScript number is never infinite.
 *   - `warmup`: the same quantity, whose first bars, seed, arithmetic order and
 *     handling of an absent value inside its window are OpenScript's own
 *     (`stdlib.md` 20). The first call of each raises OS9007.
 *   - `orders`: an order call, placed under OpenScript's order model. The first
 *     call of each raises OS9010.
 *
 * `stateful` marks a call that keeps state at its call site in OpenScript, so
 * that skipping it on a bar changes what it returns later (`language.md`
 * 11.4). It decides where the source dialect's evaluation order and
 * OpenScript's differ, which is what the logic operators' translation is about.
 */
/**
 * The rows, as source, target, source parameters, target parameters,
 * difference, stateful and the special translator. Parameters are written as
 * one space separated string so that a row stays one line.
 */
const ROWS = [
    // Bar data and bar facts.
    ['open', 'open', '', '', 'exact', false],
    ['high', 'high', '', '', 'exact', false],
    ['low', 'low', '', '', 'exact', false],
    ['close', 'close', '', '', 'exact', false],
    ['volume', 'volume', '', '', 'exact', false],
    ['hl2', 'hl2', '', '', 'exact', false],
    ['hlc3', 'hlc3', '', '', 'exact', false],
    ['ohlc4', 'ohlc4', '', '', 'exact', false],
    ['hlcc4', 'hlcc4', '', '', 'exact', false],
    ['time', 'time', '', '', 'exact', false],
    ['bar_index', 'bar.index', '', '', 'exact', false],
    ['barstate.isfirst', 'bar.isFirst', '', '', 'exact', false],
    ['barstate.islast', 'bar.isLast', '', '', 'exact', false],
    ['barstate.isconfirmed', 'bar.isConfirmed', '', '', 'exact', false],
    ['barstate.isrealtime', 'bar.isRealtime', '', '', 'exact', false],
    ['barstate.isnew', 'bar.isNew', '', '', 'exact', false],
    ['na', 'none', '', '', 'exact', false],
    ['math.pi', 'math.pi', '', '', 'exact', false],
    ['math.e', 'math.e', '', '', 'exact', false],
    ['strategy.position_size', 'pos.size', '', '', 'exact', false],
    ['strategy.position_avg_price', 'pos.avgPrice', '', '', 'exact', false],
    // Moving averages and trend.
    ['ta.sma', 'sma', 'source length', 'src len', 'warmup', true],
    ['ta.ema', 'ema', 'source length', 'src len', 'warmup', true],
    ['ta.wma', 'wma', 'source length', 'src len', 'warmup', true],
    ['ta.rma', 'rma', 'source length', 'src len', 'warmup', true],
    ['ta.hma', 'hma', 'source length', 'src len', 'warmup', true],
    ['ta.vwma', 'vwma', 'source length', 'src len', 'warmup', true],
    ['ta.swma', 'swma', 'source', 'src', 'warmup', true],
    ['ta.linreg', 'linreg', 'source length offset', 'src len offset', 'warmup', true],
    ['ta.macd', 'macd', 'source fastlen slowlen siglen', 'src fast slow signal', 'warmup', true, 'tuple'],
    ['ta.supertrend', 'supertrend', 'factor atrPeriod', 'factor atrLen', 'warmup', true, 'tuple'],
    ['ta.dmi', 'adx', 'diLength adxSmoothing', 'diLen adxLen', 'warmup', true, 'tuple'],
    // Momentum, volatility and the series helpers.
    ['ta.rsi', 'rsi', 'source length', 'src len', 'warmup', true],
    ['ta.mom', 'mom', 'source length', 'src len', 'exact', true],
    ['ta.roc', 'roc', 'source length', 'src len', 'warmup', true],
    ['ta.change', 'change', 'source length', 'src len', 'exact', true],
    ['ta.atr', 'atr', 'length', 'len', 'warmup', true],
    ['ta.tr', 'trueRange', 'handle_na', '', 'exact', false, 'trueRange'],
    ['ta.stdev', 'stdev', 'source length biased', 'src len sample', 'warmup', true, 'deviation'],
    ['ta.variance', 'variance', 'source length biased', 'src len sample', 'warmup', true, 'deviation'],
    ['ta.bb', 'bollinger', 'series length mult', 'src len mult', 'warmup', true, 'tuple'],
    ['ta.highest', 'highest', 'source length', 'src len', 'warmup', true, 'extreme'],
    ['ta.lowest', 'lowest', 'source length', 'src len', 'warmup', true, 'extreme'],
    ['ta.crossover', 'crossUp', 'source1 source2', 'a b', 'exact', true],
    ['ta.crossunder', 'crossDown', 'source1 source2', 'a b', 'exact', true],
    ['ta.cross', 'cross', 'source1 source2', 'a b', 'exact', true],
    ['ta.cum', 'cum', 'source', 'src', 'warmup', true],
    ['ta.barssince', 'barsSince', 'condition', 'cond', 'warmup', true, 'condition'],
    ['ta.valuewhen', 'valueWhen', 'condition source occurrence', 'cond src occurrence', 'warmup', true, 'condition'],
    ['math.sum', 'sum', 'source length', 'src len', 'warmup', true],
    // Maths, absence and conversion.
    ['math.abs', 'abs', 'number', 'x', 'exact', false],
    ['math.sign', 'sign', 'number', 'x', 'exact', false],
    ['math.floor', 'floor', 'number', 'x', 'exact', false],
    ['math.ceil', 'ceil', 'number', 'x', 'exact', false],
    ['math.sqrt', 'sqrt', 'number', 'x', 'exact', false],
    ['math.pow', 'pow', 'base exponent', 'x y', 'exact', false],
    ['math.exp', 'exp', 'number', 'x', 'exact', false],
    ['math.log', 'log', 'number', 'x', 'exact', false],
    ['math.log10', 'log10', 'number', 'x', 'exact', false],
    ['math.sin', 'math.sin', 'angle', 'x', 'exact', false],
    ['math.cos', 'math.cos', 'angle', 'x', 'exact', false],
    ['math.tan', 'math.tan', 'angle', 'x', 'exact', false],
    ['math.asin', 'math.asin', 'angle', 'x', 'exact', false],
    ['math.acos', 'math.acos', 'angle', 'x', 'exact', false],
    ['math.atan', 'math.atan', 'angle', 'x', 'exact', false],
    ['math.todegrees', 'math.toDegrees', 'radians', 'x', 'exact', false],
    ['math.toradians', 'math.toRadians', 'degrees', 'x', 'exact', false],
    ['math.max', 'max', 'number0 number1', 'a b', 'exact', false, 'extremes'],
    ['math.min', 'min', 'number0 number1', 'a b', 'exact', false, 'extremes'],
    ['na', 'isNone', 'x', 'x', 'exact', false],
    ['nz', 'orElse', 'source replacement', 'x fallback', 'exact', false, 'fallback'],
    ['int', 'trunc', 'x', 'x', 'exact', false],
    ['float', 'float', 'x', 'x', 'exact', false, 'float'],
    ['color.new', 'fade', 'color transp', 'color percent', 'exact', false],
    ['color.rgb', 'rgb', 'red green blue transp', 'r g b', 'exact', false, 'rgb'],
    // Declarations, inputs and what lands on the chart.
    ['indicator', 'study', 'title', '', 'exact', false, 'declaration'],
    ['strategy', 'strategy', 'title', '', 'exact', false, 'declaration'],
    ['input', 'input', 'defval title', '', 'exact', false, 'input'],
    ['input.int', 'input', 'defval title', '', 'exact', false, 'input'],
    ['input.float', 'input', 'defval title', '', 'exact', false, 'input'],
    ['input.bool', 'input', 'defval title', '', 'exact', false, 'input'],
    ['input.color', 'input', 'defval title', '', 'exact', false, 'input'],
    ['input.string', 'input', 'defval title', '', 'exact', false, 'input'],
    ['input.source', 'input', 'defval title', '', 'exact', false, 'input'],
    ['plot', 'plot', 'series title color', '', 'exact', false, 'plot'],
    ['hline', 'level', 'price title color', '', 'exact', false, 'hline'],
    ['fill', 'fill', 'plot1 plot2 color', '', 'exact', false, 'fill'],
    ['bgcolor', 'background', 'color', '', 'exact', false, 'paint'],
    ['barcolor', 'barColor', 'color', '', 'exact', false, 'paint'],
    ['plotshape', 'signal', 'series title style', '', 'exact', false, 'shape'],
    // Orders.
    ['strategy.entry', 'buy or sell', 'id direction qty', '', 'orders', false, 'entry'],
    ['strategy.close', 'close', 'id', '', 'orders', false, 'close'],
    ['strategy.close_all', 'close', '', '', 'orders', false, 'closeAll'],
    ['strategy.exit', 'exit', 'id from_entry', '', 'orders', false, 'exit'],
];
const words = (text) => (text === '' ? [] : text.split(' '));
export const MAPPINGS = ROWS.map(([source, target, params, targets, difference, stateful, special]) => ({
    source,
    target,
    params: words(params),
    targets: words(targets),
    difference,
    stateful,
    special,
}));
/** The rows that are read as a value, keyed by the source spelling. */
export const VALUES = new Map(MAPPINGS.filter((row) => row.params.length === 0 && row.special === undefined).map((row) => [row.source, row]));
/** The rows that are called, keyed by the source spelling. */
export const CALLS = new Map(MAPPINGS.filter((row) => row.params.length > 0 || row.special !== undefined).map((row) => [row.source, row]));
/**
 * The colour names both languages have, which translate to OpenScript's colour
 * of the same name. The channel values are OpenScript's (`spec/colours.json`).
 */
export const COLOURS = new Set([
    'aqua', 'black', 'blue', 'fuchsia', 'gray', 'green', 'lime', 'maroon', 'navy',
    'olive', 'orange', 'purple', 'red', 'silver', 'teal', 'white', 'yellow',
]);
//# sourceMappingURL=table.js.map