import { withoutGrouping } from '../ast/index.js';
import { argumentAt } from './context.js';
import { emitEventCall } from './events.js';
import { emitExpression } from './expressions.js';
import { CANDLE_DEFAULTS, FILL_DEFAULTS, LEVEL_DEFAULTS, PLOT_DEFAULTS, PLOT_LINE_STYLE, TABLE_DEFAULTS, } from './defaults.js';
import { fieldOf } from './values.js';
/** The argument written for one parameter of a declaration call, or nothing. */
export function argumentFor(e, call, name) {
    const checked = e.callAt(call);
    if (checked?.entry === undefined)
        return undefined;
    return argumentAt(checked, checked.entry, name);
}
/**
 * A declaration field: what the script wrote, or the effective default.
 *
 * `compiled-program.md` 2.3 wants the value the option resolved to, defaults
 * included, so an option a script left out is written with its default rather
 * than omitted. An option the compiler cannot fold has nowhere in the format to
 * live, and that is a gap rather than a guess.
 */
export function fieldFor(e, call, name, defaults) {
    const argument = argumentFor(e, call, name);
    if (argument === undefined)
        return fieldOf(defaults[name]);
    const value = e.fold(argument.value);
    if (value !== undefined)
        return fieldOf(value);
    e.gap('a declaration option written as an expression over an input cannot be carried: a field ' +
        'holds a value or a reference to one input, and this is neither', 'compiled-program.md 2.3, against language.md 13.2', argument.span, true);
    return null;
}
/** A colour that is constant lands on the declaration; one that is not, on a channel. */
function colourFor(e, f, call, name, defaults, channelName) {
    const argument = argumentFor(e, call, name);
    if (argument === undefined)
        return { colour: fieldOf(defaults[name]), channel: null };
    const value = e.fold(argument.value);
    if (value !== undefined)
        return { colour: fieldOf(value), channel: null };
    // A series colour lands on the contract's per-bar colour callback instead
    // (stdlib.md 14.2), which is how a script paints a histogram by sign.
    const channel = e.layout.channel('color', false, true, channelName);
    emitExpression(e, f, argument.value);
    f.builder.at(call.span);
    f.builder.push('EMIT', channel);
    return { colour: null, channel };
}
/**
 * The per-bar work one declaration needs, which for two of them is none.
 *
 * **Every caller of this is a statement that is entirely one declaration call**:
 * `plot(close, "C")` written on a line of its own, `panel = table(...)`, and
 * `len = input(14, "Length")`. `statements.ts` sends all three forms here
 * directly and `emitCall` sends nothing else, so reaching this function means
 * the call declares and nothing is waiting for a value from it.
 *
 * That invariant is here for one case, and it is worth the paragraph because
 * the case is easy to get subtly wrong in both directions. An `input()` is a
 * row of the settings dialog and a slot the engine writes at step 5 of every
 * bar, and 12.2 says in as many words that there is no instruction for one. But
 * that is the reading of `len = input(14, "Length")` only, where the name and
 * the input share one slot and the engine's write is the assignment. The same
 * call written inside an expression, which `language.md` 13.2 asks for on the
 * declaration line itself and 13.4 allows anywhere at the top level, has to
 * leave its value on the stack like any other expression, and an emitter that
 * emitted nothing there left the stack one value short and produced a program
 * refused at 3.5 check 5 with OS6018: a correct script told it had met a broken
 * compiler.
 *
 * So the two are told apart by **which caller they arrive through**, and never
 * by inspecting the call. The statement is the only place that can see whether
 * the call is the whole of itself, and it is the place that already knows: it
 * had to decide that anyway to know whether to emit a store. Asking here
 * instead would mean re-deriving from the checker's tables, at the one point
 * with the least context, a fact the caller was holding when it called.
 *
 * `inputs.ts` has the other half, which is the read.
 */
export function emitDeclarationCall(e, f, call, name, target) {
    switch (name) {
        case 'input':
            // The row and the slot are made before any statement is emitted, and the
            // engine writes the slot; the assignment itself has nothing to do (2.6).
            return undefined;
        case 'plot':
            return declarePlot(e, f, call);
        case 'plotCandles':
            return declareCandles(e, f, call);
        case 'fill':
            declareFill(e, f, call);
            return undefined;
        case 'level':
            declareLevel(e, f, call);
            return undefined;
        case 'table':
            declareTable(e, f, call, target);
            return undefined;
        default:
            emitEventCall(e, f, call, name);
            return undefined;
    }
}
function titleOf(e, call) {
    const field = fieldFor(e, call, 'title', {});
    return { field, text: typeof field === 'string' ? field : '' };
}
function declarePlot(e, f, call) {
    const key = `p${e.plots.length}`;
    const title = titleOf(e, call);
    const channel = e.layout.channel('number', false, true, title.text);
    const value = argumentFor(e, call, 'value');
    if (value === undefined) {
        f.builder.at(call.span);
        f.builder.push('CONST', e.pool.absent());
    }
    else {
        emitExpression(e, f, value.value);
    }
    f.builder.at(call.span);
    f.builder.push('EMIT', channel);
    const colour = colourFor(e, f, call, 'color', PLOT_DEFAULTS, title.text);
    const style = fieldFor(e, call, 'style', PLOT_DEFAULTS);
    e.plots.push({
        key,
        title: title.field,
        type: typeof style === 'string' ? style : 'line',
        channel,
        color: colour.colour,
        colorChannel: colour.channel,
        width: fieldFor(e, call, 'width', PLOT_DEFAULTS),
        lineStyle: fieldOf(PLOT_LINE_STYLE),
        offset: fieldFor(e, call, 'offset', PLOT_DEFAULTS),
        overlay: fieldFor(e, call, 'overlay', PLOT_DEFAULTS),
        scale: fieldFor(e, call, 'scale', PLOT_DEFAULTS),
        precision: fieldFor(e, call, 'precision', PLOT_DEFAULTS),
        priceFormat: fieldFor(e, call, 'format', PLOT_DEFAULTS),
        ohlc: null,
    });
    return key;
}
/**
 * `plotCandles`, which is one plot and not four.
 *
 * Four declared plots with one of them nominated as the candle's identity would
 * put four rows in a legend for one column and would need a flag to hide three
 * of them (2.8). The entry's own channel is the close channel, which is what
 * makes a band drawn to the handle follow the close column.
 */
function declareCandles(e, f, call) {
    const key = `p${e.plots.length}`;
    const title = titleOf(e, call);
    const part = (name) => {
        const channel = e.layout.channel('number', false, true, `${title.text} ${name}`);
        const argument = argumentFor(e, call, name);
        if (argument === undefined) {
            f.builder.at(call.span);
            f.builder.push('CONST', e.pool.absent());
        }
        else {
            emitExpression(e, f, argument.value);
        }
        f.builder.at(call.span);
        f.builder.push('EMIT', channel);
        return channel;
    };
    const open = part('open');
    const high = part('high');
    const low = part('low');
    const close = part('close');
    const up = colourFor(e, f, call, 'colorUp', CANDLE_DEFAULTS, `${title.text} up`);
    const down = colourFor(e, f, call, 'colorDown', CANDLE_DEFAULTS, `${title.text} down`);
    const wick = colourFor(e, f, call, 'wickColor', CANDLE_DEFAULTS, `${title.text} wick`);
    const border = colourFor(e, f, call, 'borderColor', CANDLE_DEFAULTS, `${title.text} border`);
    e.plots.push({
        key,
        title: title.field,
        type: 'candle',
        channel: close,
        color: null,
        colorChannel: null,
        width: fieldOf(PLOT_DEFAULTS['width']),
        lineStyle: fieldOf(PLOT_LINE_STYLE),
        offset: fieldOf(PLOT_DEFAULTS['offset']),
        overlay: null,
        scale: fieldOf(PLOT_DEFAULTS['scale']),
        precision: null,
        priceFormat: null,
        ohlc: {
            open,
            high,
            low,
            close,
            colorUp: up.colour,
            colorDown: down.colour,
            wickColor: wick.colour,
            borderColor: border.colour,
            colorUpChannel: up.channel,
            colorDownChannel: down.channel,
            wickColorChannel: wick.channel,
            borderColorChannel: border.channel,
        },
    });
    return key;
}
/**
 * `fill`, which names two declared columns and never two expressions.
 *
 * `color` sets both sides of the band and giving it with either of the other
 * two is OS3010, so the compiler writes that one colour into both fields and an
 * engine reads one representation of a band rather than two (2.8).
 */
function declareFill(e, f, call) {
    const between = [keyOfHandle(e, argumentFor(e, call, 'plotA')), keyOfHandle(e, argumentFor(e, call, 'plotB'))];
    const both = argumentFor(e, call, 'color');
    let up = colourFor(e, f, call, 'colorUp', FILL_DEFAULTS, 'band up');
    let down = colourFor(e, f, call, 'colorDown', FILL_DEFAULTS, 'band down');
    if (both !== undefined) {
        const one = colourFor(e, f, call, 'color', FILL_DEFAULTS, 'band');
        up = one;
        down = one;
    }
    e.fills.push({
        between: [between[0], between[1]],
        colorUp: up.colour,
        colorDown: down.colour,
        colorUpChannel: up.channel,
        colorDownChannel: down.channel,
        opacity: fieldFor(e, call, 'opacity', FILL_DEFAULTS),
        overlay: fieldFor(e, call, 'overlay', FILL_DEFAULTS),
    });
}
function keyOfHandle(e, argument) {
    if (argument === undefined)
        return '';
    const inner = withoutGrouping(argument.value);
    if (inner.kind !== 'nameReference')
        return '';
    const binding = e.bindingAt(inner);
    return binding === undefined ? '' : (e.handleKeys.get(binding.id) ?? '');
}
/**
 * `level`, whose price arrives through a channel and is evaluated every bar.
 *
 * The level drawn is the one from the last bar executed, which is what lets a
 * level track the data rather than being a compile-time constant (2.8).
 */
function declareLevel(e, f, call) {
    const title = titleOf(e, call);
    const channel = e.layout.channel('number', false, true, title.text);
    const price = argumentFor(e, call, 'price');
    if (price === undefined) {
        f.builder.at(call.span);
        f.builder.push('CONST', e.pool.absent());
    }
    else {
        emitExpression(e, f, price.value);
    }
    f.builder.at(call.span);
    f.builder.push('EMIT', channel);
    e.levels.push({
        title: title.field,
        channel,
        color: fieldFor(e, call, 'color', LEVEL_DEFAULTS),
        lineStyle: fieldFor(e, call, 'style', LEVEL_DEFAULTS),
        lineWidth: fieldFor(e, call, 'width', LEVEL_DEFAULTS),
    });
}
/**
 * `table`, the one declaration with no per-bar instruction.
 *
 * Its cells are written by library calls against the handle rather than by
 * channels, because a grid of two hundred cells would otherwise need two
 * hundred channels and almost all of them would be absent on almost every bar
 * (2.8).
 */
function declareTable(e, f, call, target) {
    const slot = target === undefined ? f.layout.slot('') : f.layout.slotFor(target);
    e.tables.push({
        key: `t${e.tables.length}`,
        title: fieldFor(e, call, 'title', {}),
        slot,
        position: fieldFor(e, call, 'position', TABLE_DEFAULTS),
        rows: fieldFor(e, call, 'rows', {}),
        cols: fieldFor(e, call, 'cols', {}),
        options: {
            textColor: fieldFor(e, call, 'textColor', TABLE_DEFAULTS),
            bgColor: fieldFor(e, call, 'bgColor', TABLE_DEFAULTS),
            borderWidth: fieldFor(e, call, 'borderWidth', TABLE_DEFAULTS),
        },
    });
}
//# sourceMappingURL=outputs.js.map