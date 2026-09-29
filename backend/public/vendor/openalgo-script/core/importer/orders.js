/**
 * The declaration, and the calls that trade.
 *
 * **The declaration** is written from the source's options where OpenScript
 * has the same option (`language.md` 13.2 and 13.3), and every default the two
 * languages disagree about is written out rather than left to the default: the
 * source dialect starts a strategy with a million in capital where OpenScript
 * starts with a hundred thousand, so a strategy that names no capital is given
 * the source's. An option with no equivalent is left out of the declaration,
 * because the file needs it, with OS9006 where it changes what is computed or
 * traded and OS9009 where it changes only what is shown.
 *
 * **An entry** in the source dialect closes an opposite position before it
 * opens its own, and is ignored while a position on its side is already held at
 * the default pyramiding. It is written as exactly that: a `close()` behind a
 * guard on the opposite side, then the entry behind a guard on its own side.
 * **An exit** that names its entry is guarded by that entry's side, so that the
 * levels of a long exit and a short exit do not replace each other on every
 * bar, and a profit or loss given in ticks is converted to a price distance by
 * the instrument's tick size. Every order call raises OS9010 once, because the
 * two order models are close and are not the same.
 */
import { diagnosticFor } from '../diagnostics/index.js';
import { bind } from './calls.js';
import { quoted } from './context.js';
import { pathOf } from './syntax.js';
import { PREC, numberText, translate, wrap } from './values.js';
/** The capital a source strategy starts with when it names none. */
const SOURCE_CAPITAL = '1000000';
const DECLARATION_POSITIONAL = ['title', 'shorttitle', 'overlay', 'format', 'precision'];
const DISPLAY = new Set([
    'max_bars_back', 'explicit_plot_zorder', 'max_lines_count', 'max_labels_count', 'max_boxes_count',
    'max_polylines_count', 'dynamic_requests', 'behind_chart', 'risk_free_rate', 'calc_bars_count',
]);
/** Options that change what is computed or traded, with the literal that changes nothing. */
const INERT = {
    timeframe: '""',
    timeframe_gaps: 'true',
    calc_on_order_fills: 'false',
    calc_on_every_tick: 'false',
    use_bar_magnifier: 'false',
    fill_orders_on_standard_ohlc: 'false',
    backtest_fill_limits_assumption: '0',
    close_entries_rule: '"FIFO"',
    margin_long: 'margin',
    margin_short: 'margin',
};
const QTY_TYPES = { fixed: 'units', cash: 'cash', percent_of_equity: 'equityPercent' };
const COMMISSIONS = { percent: 'percent', cash_per_order: 'perTrade', cash_per_contract: 'perUnit' };
function literalOf(expr) {
    if (expr === undefined)
        return undefined;
    if (expr.kind === 'number')
        return numberText(expr.text);
    if (expr.kind === 'bool')
        return String(expr.value);
    if (expr.kind === 'string')
        return quoted(expr.value);
    if (expr.kind === 'unary' && expr.op === '-' && expr.operand.kind === 'number')
        return `-${numberText(expr.operand.text)}`;
    return undefined;
}
function constantOf(expr, prefix) {
    const path = expr === undefined ? undefined : pathOf(expr);
    return path?.startsWith(prefix) ? path.slice(prefix.length) : undefined;
}
/** The declaration line, with every option it can carry. */
export function declarationLine(ctx, call, path) {
    const strategy = path === 'strategy';
    const bound = bind(call, DECLARATION_POSITIONAL);
    const cannot = (arg, name) => ctx.note(diagnosticFor('OS9006', ctx.span(arg.at), { argument: name, call: path }));
    const shownOnly = (arg, name) => ctx.note(diagnosticFor('OS9009', ctx.span(arg.at), { argument: name, call: path }));
    for (const one of bound.stray)
        cannot(one.arg, one.name);
    const titleArg = bound.byName.get('title');
    let title = titleArg?.value.kind === 'string' ? titleArg.value.value : undefined;
    if (title === undefined) {
        if (titleArg !== undefined)
            cannot(titleArg, 'title');
        title = 'Imported script';
    }
    const options = [quoted(title)];
    const put = (name, value) => {
        options.push(`${name} = ${value}`);
    };
    const commission = { type: undefined, given: false };
    for (const [name, arg] of bound.byName) {
        const literal = literalOf(arg.value);
        switch (name) {
            case 'title':
                continue;
            case 'shorttitle':
                if (arg.value.kind === 'string')
                    put('short', literal ?? '""');
                else
                    shownOnly(arg, name);
                continue;
            case 'overlay':
                if (arg.value.kind === 'bool')
                    put('overlay', literal ?? 'false');
                else
                    shownOnly(arg, name);
                continue;
            case 'precision':
                if (arg.value.kind === 'number')
                    put('precision', literal ?? '4');
                else
                    shownOnly(arg, name);
                continue;
            case 'format':
            case 'scale': {
                const word = constantOf(arg.value, `${name}.`);
                const known = name === 'format' ? ['price', 'percent', 'volume'] : ['right', 'left', 'none'];
                if (word !== undefined && known.includes(word))
                    put(name, quoted(word));
                else
                    shownOnly(arg, name);
                continue;
            }
        }
        if (DISPLAY.has(name)) {
            shownOnly(arg, name);
            continue;
        }
        const inert = INERT[name];
        if (inert !== undefined) {
            if (literal !== inert)
                cannot(arg, name);
            continue;
        }
        if (!strategy) {
            cannot(arg, name);
            continue;
        }
        const numeric = arg.value.kind === 'number' ? literal : undefined;
        switch (name) {
            case 'initial_capital':
                if (numeric !== undefined)
                    put('capital', numeric);
                else
                    cannot(arg, name);
                break;
            case 'default_qty_value':
                if (numeric !== undefined)
                    put('qty', numeric);
                else
                    cannot(arg, name);
                break;
            case 'default_qty_type': {
                const type = QTY_TYPES[constantOf(arg.value, 'strategy.') ?? ''];
                ctx.qtyInUnits = type === 'units';
                if (type !== undefined)
                    put('qtyType', quoted(type));
                else
                    cannot(arg, name);
                break;
            }
            case 'pyramiding':
                if (numeric !== undefined && Number(numeric) <= 1)
                    break;
                if (numeric !== undefined) {
                    ctx.pyramiding = Number(numeric);
                    put('pyramiding', numeric);
                }
                cannot(arg, name);
                break;
            case 'currency': {
                const code = constantOf(arg.value, 'currency.');
                if (code === undefined)
                    shownOnly(arg, name);
                else if (code !== 'NONE')
                    put('currency', quoted(code));
                break;
            }
            case 'slippage':
                if (numeric !== undefined)
                    put('slippage', numeric);
                else
                    cannot(arg, name);
                break;
            case 'commission_type':
                commission.type = COMMISSIONS[constantOf(arg.value, 'strategy.commission.') ?? ''];
                if (commission.type === undefined)
                    cannot(arg, name);
                break;
            case 'commission_value':
                if (numeric !== undefined) {
                    put('commission', numeric);
                    commission.given = true;
                }
                else
                    cannot(arg, name);
                break;
            case 'process_orders_on_close':
                if (literal === 'true')
                    put('fillOn', '"close"');
                else if (literal !== 'false')
                    cannot(arg, name);
                break;
            default:
                cannot(arg, name);
        }
    }
    if (strategy) {
        if (!bound.byName.has('initial_capital'))
            put('capital', SOURCE_CAPITAL);
        if (commission.given)
            put('commissionType', quoted(commission.type ?? 'percent'));
    }
    return `${strategy ? 'strategy' : 'study'}(${options.join(', ')})`;
}
/** OS9010, once per order call. */
function orderNote(ctx, call, path) {
    ctx.note(diagnosticFor('OS9010', ctx.span(call.callee.at), { call: path }), `OS9010 ${path}`);
}
/**
 * Refuses the first argument that changes the order with no equivalent, and
 * reports every one that changes only its label. Returns whether to go on.
 */
function sortArguments(ctx, path, bound, carried, refused) {
    const first = bound.stray[0];
    if (first !== undefined) {
        ctx.refuse(diagnosticFor('OS9006', ctx.span(first.arg.at), { argument: first.name, call: path }));
        return false;
    }
    for (const [name, arg] of bound.byName) {
        if (carried.includes(name))
            continue;
        if (refused.includes(name) || !(name.startsWith('comment') || name.startsWith('alert') || name === 'disable_alert')) {
            ctx.refuse(diagnosticFor('OS9006', ctx.span(arg.at), { argument: name, call: path }));
            return false;
        }
        ctx.note(diagnosticFor('OS9009', ctx.span(arg.at), { argument: name, call: path }));
    }
    return true;
}
function required(ctx, call, path, bound, name) {
    const arg = bound.byName.get(name);
    if (arg !== undefined)
        return translate(ctx, arg.value).text;
    ctx.refuse(diagnosticFor('OS9006', ctx.span(call.at), { argument: name, call: path }));
    return undefined;
}
export function entryLines(ctx, call, path, depth) {
    const bound = bind(call, ['id', 'direction', 'qty', 'limit', 'stop']);
    if (!sortArguments(ctx, path, bound, ['id', 'direction', 'qty'], ['limit', 'stop', 'oca_name', 'oca_type']))
        return [];
    const tag = required(ctx, call, path, bound, 'id');
    const direction = constantOf(bound.byName.get('direction')?.value, 'strategy.');
    if (tag === undefined)
        return [];
    if (direction !== 'long' && direction !== 'short') {
        ctx.refuse(diagnosticFor('OS9006', ctx.span(bound.byName.get('direction')?.at ?? call.at), { argument: 'direction', call: path }));
        return [];
    }
    const qty = bound.byName.get('qty');
    if (qty !== undefined && !ctx.qtyInUnits) {
        ctx.refuse(diagnosticFor('OS9006', ctx.span(qty.at), { argument: 'qty', call: path }));
        return [];
    }
    orderNote(ctx, call, path);
    const args = qty === undefined ? `tag = ${tag}` : `qty = ${translate(ctx, qty.value).text}, tag = ${tag}`;
    const long = direction === 'long';
    const lines = [
        { depth, text: `if pos.size ${long ? '<' : '>'} 0` },
        { depth: depth + 1, text: 'close()' },
    ];
    if (ctx.pyramiding <= 1) {
        lines.push({ depth, text: `if pos.size ${long ? '<=' : '>='} 0` }, { depth: depth + 1, text: `${long ? 'buy' : 'sell'}(${args})` });
    }
    else {
        lines.push({ depth, text: `${long ? 'buy' : 'sell'}(${args})` });
    }
    return lines;
}
export function closeLines(ctx, call, path, depth) {
    const all = path === 'strategy.close_all';
    const bound = bind(call, all ? [] : ['id']);
    if (!sortArguments(ctx, path, bound, ['id'], ['qty', 'qty_percent', 'immediately']))
        return [];
    if (all) {
        orderNote(ctx, call, path);
        return [{ depth, text: 'close()' }];
    }
    const tag = required(ctx, call, path, bound, 'id');
    if (tag === undefined)
        return [];
    orderNote(ctx, call, path);
    return [{ depth, text: `close(tag = ${tag})` }];
}
export function exitLines(ctx, call, path, depth) {
    const bound = bind(call, ['id', 'from_entry', 'qty', 'qty_percent', 'profit', 'limit', 'loss', 'stop']);
    const carried = ['id', 'from_entry', 'profit', 'limit', 'loss', 'stop'];
    const refused = ['qty', 'qty_percent', 'trail_price', 'trail_points', 'trail_offset', 'oca_name'];
    if (!sortArguments(ctx, path, bound, carried, refused))
        return [];
    for (const [distance, price] of [['profit', 'limit'], ['loss', 'stop']]) {
        const both = bound.byName.get(distance);
        if (both !== undefined && bound.byName.has(price)) {
            ctx.refuse(diagnosticFor('OS9006', ctx.span(both.at), { argument: distance, call: path }));
            return [];
        }
    }
    const tag = required(ctx, call, path, bound, 'id');
    if (tag === undefined)
        return [];
    let guard;
    const from = bound.byName.get('from_entry');
    if (from !== undefined) {
        const side = from.value.kind === 'string' ? ctx.facts.entries.get(from.value.value) : undefined;
        if (side === undefined) {
            ctx.refuse(diagnosticFor('OS9006', ctx.span(from.at), { argument: 'from_entry', call: path }));
            return [];
        }
        guard = side === 'long' ? 'if pos.size >= 0' : 'if pos.size <= 0';
    }
    const parts = [`tag = ${tag}`];
    for (const name of ['stop', 'limit']) {
        const arg = bound.byName.get(name);
        if (arg !== undefined)
            parts.push(`${name} = ${translate(ctx, arg.value).text}`);
    }
    for (const name of ['profit', 'loss']) {
        const arg = bound.byName.get(name);
        if (arg !== undefined)
            parts.push(`${name} = ${wrap(translate(ctx, arg.value), PREC.multiplicative)} * chart.tickSize`);
    }
    orderNote(ctx, call, path);
    const line = `exit(${parts.join(', ')})`;
    return guard === undefined ? [{ depth, text: line }] : [{ depth, text: guard }, { depth: depth + 1, text: line }];
}
//# sourceMappingURL=orders.js.map