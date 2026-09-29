/**
 * Inputs, and what lands on the chart.
 *
 * Every argument of a drawing call is about the picture, so an argument with no
 * OpenScript spelling is left out with OS9009 and the call is kept. An input is
 * kept as well when one of its arguments cannot be carried, because the rest of
 * the script reads the value it declares, and that argument is reported with
 * OS9006 instead.
 *
 * OpenScript keys a column, a level, a marker and an input by its title and
 * refuses two of one kind with one title (OS3017), where the source dialect
 * accepts both. A repeated title is therefore numbered, which changes a label
 * and nothing a script computes.
 */
import { diagnosticFor } from '../diagnostics/index.js';
import { bind, onlyKnown } from './calls.js';
import { quoted } from './context.js';
import { pathOf } from './syntax.js';
import { NOTHING, atom, translate } from './values.js';
const INPUT_ARGUMENTS = ['defval', 'title', 'minval', 'maxval', 'step', 'tooltip', 'inline', 'group', 'confirm', 'options', 'display'];
const PRESENTATION_ONLY = new Set(['inline', 'confirm', 'display']);
function literalString(expr) {
    return expr?.kind === 'string' ? expr.value : undefined;
}
/** OS9009 for an argument that changes only the picture. */
function leftOut(ctx, arg, name, call) {
    ctx.note(diagnosticFor('OS9009', ctx.span(arg.at), { argument: name, call }));
}
/**
 * `input.int(14, "Length", minval = 1)` and its siblings, as one `input()`.
 *
 * `assigned` is whether the input is the whole value of a declaration, where
 * OpenScript takes the name as the title and a title may be left out.
 */
export function translateInput(ctx, call, path, assigned) {
    const bound = bind(call, ['defval', 'title']);
    if (!onlyKnown(ctx, path, bound, INPUT_ARGUMENTS))
        return NOTHING;
    const defval = bound.byName.get('defval');
    if (defval === undefined) {
        ctx.refuse(diagnosticFor('OS9006', ctx.span(call.at), { argument: 'defval', call: path }));
        return NOTHING;
    }
    const parts = [translate(ctx, defval.value).text];
    const titleArg = bound.byName.get('title');
    const written = literalString(titleArg?.value);
    if (titleArg !== undefined && written === undefined)
        leftOut(ctx, titleArg, 'title', path);
    if (written !== undefined && written !== '')
        parts.push(quoted(ctx.title('input', written)));
    else if (!assigned)
        parts.push(quoted(ctx.title('input', 'Input')));
    const numeric = path === 'input.int' || path === 'input.float' || (path === 'input' && defval.value.kind === 'number');
    for (const [source, target] of [['minval', 'min'], ['maxval', 'max'], ['step', 'step']]) {
        const arg = bound.byName.get(source);
        if (arg !== undefined)
            parts.push(`${target} = ${translate(ctx, arg.value).text}`);
    }
    const options = bound.byName.get('options');
    if (options !== undefined) {
        if (numeric)
            ctx.note(diagnosticFor('OS9006', ctx.span(options.at), { argument: 'options', call: path }));
        else
            parts.push(`options = ${listText(ctx, options.value)}`);
    }
    for (const name of ['group', 'tooltip']) {
        const arg = bound.byName.get(name);
        if (arg !== undefined)
            parts.push(`${name} = ${translate(ctx, arg.value).text}`);
    }
    for (const [name, arg] of bound.byName)
        if (PRESENTATION_ONLY.has(name))
            leftOut(ctx, arg, name, path);
    return atom(`input(${parts.join(', ')})`);
}
function listText(ctx, expr) {
    if (expr.kind !== 'list')
        return translate(ctx, expr).text;
    return `[${expr.items.map((item) => translate(ctx, item).text).join(', ')}]`;
}
/** A member constant's last word, when the argument is `namespace.word`. */
function constantOf(expr, namespace) {
    const path = expr === undefined ? undefined : pathOf(expr);
    return path?.startsWith(`${namespace}.`) ? path.slice(namespace.length + 1) : undefined;
}
const PLOT_STYLES = {
    style_line: null,
    style_linebr: null,
    style_stepline: 'step',
    style_steplinebr: 'step',
    style_histogram: 'histogram',
    style_columns: 'column',
    style_area: 'area',
    style_areabr: 'area',
};
const FORMATS = new Set(['price', 'percent', 'volume']);
/** The title a declared output is given: the source's literal, or a name made from what it draws. */
function outputTitle(ctx, kind, arg, drawn, fallback, call) {
    const written = literalString(arg?.value);
    if (arg !== undefined && written === undefined)
        leftOut(ctx, arg, 'title', call);
    const base = written !== undefined && written !== '' ? written : drawn?.kind === 'name' ? drawn.name : fallback;
    return ctx.title(kind, base);
}
const PLOT_ARGUMENTS = ['series', 'title', 'color', 'linewidth', 'style', 'trackprice', 'histbase', 'offset', 'join', 'editable', 'show_last', 'display'];
export function plotCall(ctx, call, path) {
    const bound = bind(call, PLOT_ARGUMENTS);
    const series = bound.byName.get('series');
    if (series === undefined || bound.stray.length > 0) {
        ctx.refuse(diagnosticFor('OS9006', ctx.span(call.at), { argument: 'series', call: path }));
        return NOTHING;
    }
    const parts = [translate(ctx, series.value).text];
    parts.push(quoted(outputTitle(ctx, 'plot', bound.byName.get('title'), series.value, 'Plot', path)));
    for (const [name, arg] of bound.byName) {
        if (name === 'series' || name === 'title')
            continue;
        if (name === 'color')
            parts.splice(2, 0, translate(ctx, arg.value).text);
        else if (name === 'linewidth')
            parts.push(`width = ${translate(ctx, arg.value).text}`);
        else if (name === 'offset' || name === 'precision')
            parts.push(`${name} = ${translate(ctx, arg.value).text}`);
        else if (name === 'style' && PLOT_STYLES[constantOf(arg.value, 'plot') ?? ''] !== undefined) {
            const style = PLOT_STYLES[constantOf(arg.value, 'plot') ?? ''];
            if (style !== null && style !== undefined)
                parts.push(`style = ${quoted(style)}`);
        }
        else if (name === 'format' && FORMATS.has(constantOf(arg.value, 'format') ?? '')) {
            parts.push(`format = ${quoted(constantOf(arg.value, 'format') ?? '')}`);
        }
        else
            leftOut(ctx, arg, name, path);
    }
    return atom(`plot(${parts.join(', ')})`);
}
const LINE_STYLES = { style_solid: 'solid', style_dotted: 'dotted', style_dashed: 'dashed' };
export function levelCall(ctx, call, path) {
    const bound = bind(call, ['price', 'title', 'color', 'linestyle', 'linewidth', 'editable', 'display']);
    const price = bound.byName.get('price');
    if (price === undefined || bound.stray.length > 0) {
        ctx.refuse(diagnosticFor('OS9006', ctx.span(call.at), { argument: 'price', call: path }));
        return NOTHING;
    }
    const parts = [translate(ctx, price.value).text];
    const titleArg = bound.byName.get('title');
    const written = literalString(titleArg?.value);
    if (titleArg !== undefined && written === undefined)
        leftOut(ctx, titleArg, 'title', path);
    if (written !== undefined && written !== '')
        parts.push(quoted(ctx.title('level', written)));
    for (const [name, arg] of bound.byName) {
        if (name === 'price' || name === 'title')
            continue;
        const style = LINE_STYLES[constantOf(arg.value, 'hline') ?? ''];
        if (name === 'color')
            parts.push(`color = ${translate(ctx, arg.value).text}`);
        else if (name === 'linewidth')
            parts.push(`width = ${translate(ctx, arg.value).text}`);
        else if (name === 'linestyle' && style !== undefined)
            parts.push(`style = ${quoted(style)}`);
        else
            leftOut(ctx, arg, name, path);
    }
    return atom(`level(${parts.join(', ')})`);
}
/** `fill` between two named plots; a level or an expression in either place is refused. */
export function fillLine(ctx, call, path, depth) {
    const bound = bind(call, ['plot1', 'plot2', 'color']);
    const ends = [bound.byName.get('plot1') ?? bound.byName.get('hline1'), bound.byName.get('plot2') ?? bound.byName.get('hline2')];
    const names = [];
    for (const end of ends) {
        const binding = end?.value.kind === 'name' ? ctx.lookup(end.value.name, end.value.at) : undefined;
        if (end === undefined || binding === undefined || binding.handle === undefined) {
            ctx.refuse(diagnosticFor('OS9002', ctx.span(call.at), { construct: 'a fill between values that are not plots' }));
            return [];
        }
        if (binding.handle === 'level') {
            ctx.refuse(diagnosticFor('OS9002', ctx.span(call.at), { construct: 'a fill that ends at a horizontal line' }));
            return [];
        }
        names.push(binding.output);
    }
    const parts = [...names];
    for (const [name, arg] of bound.byName) {
        if (['plot1', 'plot2', 'hline1', 'hline2'].includes(name))
            continue;
        if (name === 'color')
            parts.push(`color = ${translate(ctx, arg.value).text}`);
        else
            leftOut(ctx, arg, name, path);
    }
    for (const one of bound.stray)
        leftOut(ctx, one.arg, one.name, path);
    return [{ depth, text: `fill(${parts.join(', ')})` }];
}
/** `bgcolor` and `barcolor`, which paint one bar and take a colour. */
export function paintLine(ctx, call, path, target, depth) {
    const bound = bind(call, ['color']);
    const colour = bound.byName.get('color');
    if (colour === undefined) {
        ctx.refuse(diagnosticFor('OS9006', ctx.span(call.at), { argument: 'color', call: path }));
        return [];
    }
    for (const [name, arg] of bound.byName)
        if (name !== 'color')
            leftOut(ctx, arg, name, path);
    for (const one of bound.stray)
        leftOut(ctx, one.arg, one.name, path);
    return [{ depth, text: `${target}(${translate(ctx, colour.value).text})` }];
}
const SHAPES = {
    triangleup: 'triangleUp',
    triangledown: 'triangleDown',
    arrowup: 'arrowUp',
    arrowdown: 'arrowDown',
    circle: 'circle',
    square: 'square',
    diamond: 'diamond',
    cross: 'cross',
    flag: 'flag',
    labelup: 'label',
    labeldown: 'label',
};
const LOCATIONS = { abovebar: 'above', belowbar: 'below' };
/** `plotshape(cond, ...)`, which draws on the bars its series holds: a marker behind an if. */
export function shapeLines(ctx, call, path, depth) {
    const bound = bind(call, ['series', 'title', 'style', 'location', 'color']);
    const series = bound.byName.get('series');
    if (series === undefined) {
        ctx.refuse(diagnosticFor('OS9006', ctx.span(call.at), { argument: 'series', call: path }));
        return [];
    }
    const condition = translate(ctx, series.value).text;
    const textArg = bound.byName.get('text');
    const text = literalString(textArg?.value);
    const shown = text !== undefined && text !== '';
    const titleArg = bound.byName.get('title');
    if (textArg !== undefined && !shown)
        leftOut(ctx, textArg, 'text', path);
    if (titleArg !== undefined && shown)
        leftOut(ctx, titleArg, 'title', path);
    const title = outputTitle(ctx, 'signal', shown ? textArg : titleArg, undefined, 'Shape', path);
    const parts = [quoted(title)];
    for (const [name, arg] of bound.byName) {
        if (name === 'series' || name === 'title' || name === 'text')
            continue;
        const shape = SHAPES[constantOf(arg.value, 'shape') ?? ''];
        const location = LOCATIONS[constantOf(arg.value, 'location') ?? ''];
        if (name === 'color')
            parts.push(`color = ${translate(ctx, arg.value).text}`);
        else if (name === 'style' && shape !== undefined)
            parts.push(`shape = ${quoted(shape)}`);
        else if (name === 'location' && location !== undefined)
            parts.push(`at = ${quoted(location)}`);
        else
            leftOut(ctx, arg, name, path);
    }
    for (const one of bound.stray)
        leftOut(ctx, one.arg, one.name, path);
    return [
        { depth, text: `if ${condition}` },
        { depth: depth + 1, text: `signal(${parts.join(', ')})` },
    ];
}
//# sourceMappingURL=outputs.js.map