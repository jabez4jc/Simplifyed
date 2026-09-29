import { MS } from './bars.js';
import { cssOf } from './colours.js';
/** A colour a script left absent: nothing is drawn there. */
const TRANSPARENT = 'rgba(0, 0, 0, 0)';
const LINE_STYLES = ['solid', 'dashed', 'dotted'];
const ALIGNMENTS = ['left', 'center', 'right'];
/**
 * One point, or nothing when either half of it is absent.
 *
 * The time crosses the same boundary a bar's does and in the same direction: an
 * anchor is written in the language's milliseconds and a chart counts seconds,
 * so an anchor handed over unconverted would sit fifty thousand years past the
 * newest bar and still draw. It is not rounded, because rounding an anchor moves
 * it, and a chart places one between two bars perfectly well.
 */
function anchorOf(anchor) {
    if (anchor === undefined || anchor.time === null || anchor.price === null)
        return undefined;
    return { time: anchor.time / MS, price: anchor.price };
}
function colour(style, key) {
    return cssOf(style[key] ?? null) ?? TRANSPARENT;
}
function number(style, key) {
    const value = style[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function text(style, key) {
    const value = style[key];
    return typeof value === 'string' && value !== '' ? value : undefined;
}
function flag(style, key) {
    const value = style[key];
    return typeof value === 'boolean' ? value : undefined;
}
function lineStyle(style) {
    const value = style['style'];
    return typeof value === 'string' && LINE_STYLES.includes(value)
        ? value
        : undefined;
}
function align(style) {
    const value = style['align'];
    return typeof value === 'string' && ALIGNMENTS.includes(value)
        ? value
        : undefined;
}
function oneLine(one) {
    const from = anchorOf(one.anchors[0]);
    const to = anchorOf(one.anchors[1]);
    if (from === undefined || to === undefined)
        return [];
    const width = number(one.style, 'width');
    const dash = lineStyle(one.style);
    const left = flag(one.style, 'extendLeft');
    const right = flag(one.style, 'extendRight');
    return [
        {
            kind: 'line',
            from,
            to,
            color: colour(one.style, 'color'),
            ...(width === undefined ? {} : { lineWidth: width }),
            ...(dash === undefined ? {} : { lineStyle: dash }),
            ...(left === undefined ? {} : { extendLeft: left }),
            ...(right === undefined ? {} : { extendRight: right }),
        },
    ];
}
function oneBox(one) {
    const from = anchorOf(one.anchors[0]);
    const to = anchorOf(one.anchors[1]);
    if (from === undefined || to === undefined)
        return [];
    const opacity = number(one.style, 'opacity');
    const width = number(one.style, 'width');
    const caption = text(one.style, 'text');
    const tooltip = text(one.style, 'tooltip');
    return [
        {
            kind: 'box',
            from,
            to,
            color: colour(one.style, 'color'),
            fillColor: colour(one.style, 'fillColor'),
            textColor: colour(one.style, 'textColor'),
            ...(opacity === undefined ? {} : { opacity }),
            ...(width === undefined ? {} : { lineWidth: width }),
            ...(caption === undefined ? {} : { text: caption }),
            ...(tooltip === undefined ? {} : { tooltip }),
        },
    ];
}
function oneLabel(one) {
    const at = anchorOf(one.anchors[0]);
    const written = one.style['text'];
    if (at === undefined || typeof written !== 'string')
        return [];
    const placement = align(one.style);
    const tooltip = text(one.style, 'tooltip');
    return [
        {
            kind: 'label',
            at,
            text: written,
            color: colour(one.style, 'color'),
            textColor: colour(one.style, 'textColor'),
            ...(placement === undefined ? {} : { align: placement }),
            ...(tooltip === undefined ? {} : { tooltip }),
        },
    ];
}
/** The path cut at its gaps: one run of points per stretch that has none. */
function runsOf(one) {
    const runs = [];
    let run = [];
    for (const point of one.anchors) {
        const anchor = anchorOf(point);
        if (anchor === undefined) {
            if (run.length > 1)
                runs.push(run);
            run = [];
            continue;
        }
        run.push(anchor);
    }
    if (run.length > 1)
        runs.push(run);
    return runs;
}
function onePolyline(one) {
    const runs = runsOf(one);
    const whole = runs.length === 1 && runs[0]?.length === one.anchors.length;
    const width = number(one.style, 'width');
    const opacity = number(one.style, 'opacity');
    const closed = flag(one.style, 'closed');
    const filled = whole
        ? {
            fillColor: colour(one.style, 'fillColor'),
            ...(closed === undefined ? {} : { closed }),
            ...(opacity === undefined ? {} : { opacity }),
        }
        : {};
    return runs.map((points) => ({
        kind: 'polyline',
        points,
        color: colour(one.style, 'color'),
        ...(width === undefined ? {} : { lineWidth: width }),
        ...filled,
    }));
}
/**
 * Every object the script holds, in the order it created them.
 *
 * Creation order rather than any other, because it is the order the script wrote
 * and therefore the order a reader expects one shape to sit over another.
 */
export function buildDrawings(held) {
    const out = [];
    for (const one of held) {
        if (one.kind === 'line')
            out.push(...oneLine(one));
        else if (one.kind === 'box')
            out.push(...oneBox(one));
        else if (one.kind === 'label')
            out.push(...oneLabel(one));
        else
            out.push(...onePolyline(one));
    }
    return out;
}
//# sourceMappingURL=drawings.js.map