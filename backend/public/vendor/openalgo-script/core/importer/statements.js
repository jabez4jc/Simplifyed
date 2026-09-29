/**
 * Statements, written out as OpenScript lines.
 *
 * Each statement is translated inside a frame that collects the lines it needs
 * evaluated before it: version 5's always evaluated right operand of `and` and
 * `or`, moved to a line of its own (see `values.ts`). A frame allows that only
 * where the moved line runs exactly as often as the statement did, so it is
 * allowed for a plain statement and for the first condition of an `if`, and
 * refused for an `else if`, a `while` and a `switch` arm, whose conditions the
 * source evaluates only on some passes.
 */
import { diagnosticFor } from '../diagnostics/index.js';
import { canonicalNumber } from '../emit/index.js';
import { generic } from './calls.js';
import { binding } from './names.js';
import { fillLine, paintLine, plotCall, levelCall, shapeLines, translateInput } from './outputs.js';
import { closeLines, entryLines, exitLines } from './orders.js';
import { holdsState, mentions, neverAbsent, wholeConstant } from './presence.js';
import { pathOf } from './syntax.js';
import { CALLS } from './table.js';
import { translate, wrap, PREC } from './values.js';
/** Runs `work` in a frame of its own, and puts the lines it moved before its own. */
function framed(ctx, depth, mayHoist, work) {
    const held = { hoisted: ctx.hoisted, mayHoist: ctx.mayHoist, depth: ctx.depth };
    ctx.hoisted = [];
    ctx.mayHoist = mayHoist;
    ctx.depth = depth;
    try {
        const lines = work();
        return [...ctx.hoisted, ...lines];
    }
    finally {
        ctx.hoisted = held.hoisted;
        ctx.mayHoist = held.mayHoist;
        ctx.depth = held.depth;
    }
}
/** A condition read where nothing may be moved out of it. */
function fixedCondition(ctx, expr) {
    const may = ctx.mayHoist;
    ctx.mayHoist = false;
    try {
        return translate(ctx, expr).text;
    }
    finally {
        ctx.mayHoist = may;
    }
}
function translateBody(ctx, body, depth) {
    const lines = [];
    for (const entry of body) {
        if (entry.kind === 'remark')
            lines.push({ depth, text: `//${entry.remark.text}` });
        else if (entry.kind === 'blank')
            lines.push({ depth, text: '' });
        else
            lines.push(...translateStatement(ctx, entry.stmt, depth));
    }
    return lines;
}
function block(ctx, body, depth) {
    return ctx.within(() => translateBody(ctx, body, depth));
}
/** Where the value is a call, its path, unless the script declares the name. */
function builtInPath(ctx, expr) {
    if (expr.kind !== 'call')
        return undefined;
    const path = pathOf(expr.callee);
    if (path === undefined || ctx.scope.find(path.split('.')[0] ?? '') !== undefined)
        return undefined;
    return path;
}
function declare(ctx, stmt, depth) {
    const name = stmt.name.name;
    const output = ctx.namer.declare(name, ctx.hides(name));
    const bound = binding(output, 'variable', ctx.scope.isGlobal);
    // The source may read the name's own history in its first value, as OpenScript may.
    if (mentions(stmt.value, name))
        ctx.scope.names.set(name, bound);
    const path = builtInPath(ctx, stmt.value);
    const special = path === undefined ? undefined : CALLS.get(path)?.special;
    let value;
    if (special === 'input' && path !== undefined)
        value = translateInput(ctx, stmt.value, path, true);
    else if (special === 'plot' && path !== undefined)
        value = plotCall(ctx, stmt.value, path);
    else if (special === 'hline' && path !== undefined)
        value = levelCall(ctx, stmt.value, path);
    else
        value = translate(ctx, stmt.value);
    bound.handle = special === 'plot' ? 'plot' : special === 'hline' ? 'level' : undefined;
    const reassigned = ctx.facts.reassigned.get(name);
    bound.present = neverAbsent(ctx, stmt.value);
    bound.whole = reassigned === undefined && stmt.mode === 'plain' && ctx.scope.isGlobal && wholeConstant(ctx, stmt.value);
    ctx.scope.names.set(name, bound);
    // Present only if every later value is, each read as if the name itself were.
    if (bound.present && reassigned !== undefined) {
        bound.present = reassigned.every((one) => one.op !== '/=' && one.op !== '%=' && neverAbsent(ctx, one.value));
    }
    const prefix = stmt.mode === 'var' ? 'var ' : stmt.mode === 'varip' ? 'live var ' : '';
    return [{ depth, text: `${prefix}${output} = ${value.text}` }];
}
/** How each tuple built-in's elements line up with OpenScript's array. */
const ELEMENTS = {
    'ta.macd': [0, 1, 2],
    'ta.bb': [0, 1, 2],
    'ta.supertrend': [0, 1],
    'ta.dmi': [1, 2, 0],
};
function tuple(ctx, stmt, depth) {
    const bindAll = () => {
        for (const one of stmt.names) {
            const out = ctx.namer.declare(one.name, ctx.hides(one.name));
            ctx.scope.names.set(one.name, binding(out, 'variable', ctx.scope.isGlobal));
        }
    };
    const path = builtInPath(ctx, stmt.value);
    const row = path === undefined ? undefined : CALLS.get(path);
    const order = path === undefined ? undefined : ELEMENTS[path];
    if (path === undefined || row === undefined || order === undefined || order.length !== stmt.names.length) {
        if (path !== undefined && row === undefined && stmt.value.kind === 'call') {
            ctx.refuse(diagnosticFor('OS9003', ctx.span(stmt.value.callee.at), { name: path }));
        }
        else
            ctx.refuse(diagnosticFor('OS9002', ctx.span(stmt.at), { construct: 'a tuple assignment' }));
        bindAll();
        return [];
    }
    const value = generic(ctx, stmt.value, row, path);
    const holder = ctx.namer.fresh(`${row.target}Result`);
    const lines = [{ depth, text: `${holder} = ${value.text}` }];
    stmt.names.forEach((one, i) => {
        const out = ctx.namer.declare(one.name, ctx.hides(one.name));
        ctx.scope.names.set(one.name, binding(out, 'variable', ctx.scope.isGlobal));
        if (one.name !== '_')
            lines.push({ depth, text: `${out} = ${holder}[${canonicalNumber(order[i] ?? 0)}]` });
    });
    return lines;
}
function assign(ctx, stmt, depth) {
    const target = ctx.lookup(stmt.name.name, stmt.name.at);
    if (target === undefined) {
        ctx.refuse(diagnosticFor('OS9003', ctx.span(stmt.name.at), { name: stmt.name.name }));
        return [];
    }
    if (target.kind !== 'variable') {
        ctx.refuse(diagnosticFor('OS9002', ctx.span(stmt.name.at), { construct: 'an assignment to a loop variable or a parameter' }));
        return [];
    }
    const value = translate(ctx, stmt.value);
    return [{ depth, text: `${target.output} ${stmt.op === ':=' ? '=' : stmt.op} ${value.text}` }];
}
function evaluate(ctx, stmt, depth) {
    const path = builtInPath(ctx, stmt.expr);
    const call = stmt.expr;
    switch (path === undefined ? undefined : CALLS.get(path)?.special) {
        case 'declaration':
            ctx.refuse(diagnosticFor('OS9004', ctx.span(call.callee.at), { found: 'makes a second one here' }));
            return [];
        case 'fill':
            return fillLine(ctx, call, path ?? '', depth);
        case 'paint':
            return paintLine(ctx, call, path ?? '', path === 'bgcolor' ? 'background' : 'barColor', depth);
        case 'shape':
            return shapeLines(ctx, call, path ?? '', depth);
        case 'entry':
            return entryLines(ctx, call, path ?? '', depth);
        case 'close':
        case 'closeAll':
            return closeLines(ctx, call, path ?? '', depth);
        case 'exit':
            return exitLines(ctx, call, path ?? '', depth);
    }
    return [{ depth, text: translate(ctx, stmt.expr).text }];
}
function ifLines(ctx, stmt, depth) {
    const lines = [];
    stmt.branches.forEach((branch, i) => {
        const condition = i === 0 ? translate(ctx, branch.condition).text : fixedCondition(ctx, branch.condition);
        lines.push({ depth, text: `${i === 0 ? 'if' : 'else if'} ${condition}` }, ...block(ctx, branch.body, depth + 1));
    });
    if (stmt.otherwise !== undefined)
        lines.push({ depth, text: 'else' }, ...block(ctx, stmt.otherwise, depth + 1));
    return lines;
}
/** A literal number, signed or not, as its value. */
function literalValue(expr) {
    if (expr.kind === 'number')
        return Number(expr.text);
    if (expr.kind === 'unary' && expr.op === '-' && expr.operand.kind === 'number')
        return -Number(expr.operand.text);
    if (expr.kind === 'group')
        return literalValue(expr.inner);
    return undefined;
}
/** Names a loop body assigns, which a bound that is read again on each pass would see change. */
function assigned(body, into) {
    for (const entry of body) {
        if (entry.kind !== 'stmt')
            continue;
        const stmt = entry.stmt;
        if (stmt.kind === 'assign' || stmt.kind === 'declare')
            into.add(stmt.name.name);
        if (stmt.kind === 'if') {
            for (const branch of stmt.branches)
                assigned(branch.body, into);
            if (stmt.otherwise !== undefined)
                assigned(stmt.otherwise, into);
        }
        if (stmt.kind === 'for' || stmt.kind === 'while')
            assigned(stmt.body, into);
        if (stmt.kind === 'switch')
            for (const arm of stmt.arms)
                assigned(arm.body, into);
    }
    return into;
}
function forLines(ctx, stmt, depth) {
    const changes = assigned(stmt.body, new Set());
    const bounds = [stmt.from, stmt.to, ...(stmt.by === undefined ? [] : [stmt.by])];
    if (bounds.some((bound) => holdsState(ctx, bound) || [...changes].some((name) => mentions(bound, name)))) {
        ctx.refuse(diagnosticFor('OS9002', ctx.span(stmt.at), { construct: 'a for loop whose bounds change as it runs' }));
        return [];
    }
    const from = translate(ctx, stmt.from);
    const to = translate(ctx, stmt.to);
    const start = literalValue(stmt.from);
    const end = literalValue(stmt.to);
    const step = stmt.by === undefined ? undefined : literalValue(stmt.by);
    let stepText = '';
    if (stmt.by !== undefined) {
        if (start === undefined || end === undefined || step === undefined || step <= 0 || start > end) {
            ctx.refuse(diagnosticFor('OS9002', ctx.span(stmt.at), { construct: 'a for loop with a step whose direction the importer cannot settle' }));
            return [];
        }
        stepText = ` step ${translate(ctx, stmt.by).text}`;
    }
    else if (start !== undefined && end !== undefined) {
        if (start > end)
            stepText = ' step -1';
    }
    else {
        stepText = ` step (${wrap(to, PREC.comparison + 1)} >= ${wrap(from, PREC.comparison + 1)} ? 1 : -1)`;
    }
    return ctx.within(() => {
        const name = stmt.variable.name;
        const output = ctx.namer.declare(name, ctx.hides(name));
        ctx.scope.names.set(name, binding(output, 'loop', false));
        const header = { depth, text: `for ${output} = ${from.text} to ${to.text}${stepText}` };
        return [header, ...translateBody(ctx, stmt.body, depth + 1)];
    });
}
function switchLines(ctx, stmt, depth) {
    const subject = stmt.subject === undefined ? '' : ` ${fixedCondition(ctx, stmt.subject)}`;
    const lines = [{ depth, text: `switch${subject}` }];
    for (const arm of stmt.arms) {
        const head = arm.match === undefined ? 'default' : `case ${fixedCondition(ctx, arm.match)}`;
        lines.push({ depth: depth + 1, text: head }, ...block(ctx, arm.body, depth + 2));
    }
    return lines;
}
function functionLines(ctx, stmt, depth) {
    const output = ctx.namer.declare(stmt.name.name, ctx.hides(stmt.name.name));
    const fn = binding(output, 'function', ctx.scope.isGlobal);
    ctx.scope.names.set(stmt.name.name, fn);
    return ctx.within(() => {
        const labels = new Map();
        const params = stmt.params.map((param) => {
            const fallback = param.fallback === undefined ? '' : ` = ${translate(ctx, param.fallback).text}`;
            const out = ctx.namer.declare(param.name, ctx.hides(param.name));
            ctx.scope.names.set(param.name, binding(out, 'parameter', false));
            labels.set(param.name, out);
            return `${out}${fallback}`;
        });
        fn.labels = labels;
        const header = `fn ${output}(${params.join(', ')}) =>`;
        if (!Array.isArray(stmt.body)) {
            const body = stmt.body;
            const lines = framed(ctx, depth + 1, true, () => [{ depth: depth + 1, text: translate(ctx, body).text }]);
            if (lines.length === 1)
                return [{ depth, text: `${header} ${lines[0]?.text ?? ''}` }];
            return [{ depth, text: header }, ...lines];
        }
        const body = stmt.body;
        const lines = translateBody(ctx, body, depth + 1);
        const last = [...body].reverse().find((entry) => entry.kind === 'stmt');
        const tail = last?.kind === 'stmt' ? last.stmt : undefined;
        if (tail !== undefined && ['if', 'for', 'while', 'switch'].includes(tail.kind)) {
            ctx.refuse(diagnosticFor('OS9002', ctx.span(tail.at), { construct: 'a function whose last line is a block' }));
            return [];
        }
        if (tail !== undefined && (tail.kind === 'declare' || tail.kind === 'assign')) {
            lines.push({ depth: depth + 1, text: ctx.scope.find(tail.name.name)?.output ?? tail.name.name });
        }
        return [{ depth, text: header }, ...lines];
    });
}
/** A statement's own lines, before anything it moved out of itself is put in front. */
function ownLines(ctx, stmt, depth) {
    switch (stmt.kind) {
        case 'declare':
            return declare(ctx, stmt, depth);
        case 'tuple':
            return tuple(ctx, stmt, depth);
        case 'assign':
            return assign(ctx, stmt, depth);
        case 'evaluate':
            return evaluate(ctx, stmt, depth);
        case 'if':
            return ifLines(ctx, stmt, depth);
        case 'for':
            return forLines(ctx, stmt, depth);
        case 'while':
            return [{ depth, text: `while ${fixedCondition(ctx, stmt.condition)}` }, ...block(ctx, stmt.body, depth + 1)];
        case 'switch':
            return switchLines(ctx, stmt, depth);
        case 'break':
        case 'continue':
            return [{ depth, text: stmt.kind }];
        case 'function':
            return functionLines(ctx, stmt, depth);
        case 'refused':
            ctx.refuse(diagnosticFor('OS9002', ctx.span(stmt.at), { construct: stmt.construct }));
            return [];
    }
}
/** Where the source wrote a comment after the statement, it goes after its first line. */
function remarked(stmt, lines) {
    const first = lines[0];
    if (first === undefined || stmt.remarks.length === 0)
        return lines;
    const trailing = stmt.remarks.map((one) => `//${one.text}`).join(' ');
    return [{ depth: first.depth, text: `${first.text}  ${trailing}` }, ...lines.slice(1)];
}
export function translateStatement(ctx, stmt, depth) {
    const hoists = stmt.kind !== 'while' && stmt.kind !== 'switch' && stmt.kind !== 'function' && stmt.kind !== 'refused';
    return framed(ctx, depth, hoists, () => remarked(stmt, ownLines(ctx, stmt, depth)));
}
//# sourceMappingURL=statements.js.map