/**
 * Statements and blocks in the source dialect.
 *
 * A block is the run of lines indented past its header, as in OpenScript. A
 * statement the reader cannot take apart is not a parse error that stops the
 * file: it becomes one `refused` statement covering its own lines and its
 * block, so the translator can keep it as a comment and go on to the next.
 */
import { Cursor, Unreadable, UNREAD, badConstruct, expression, placeOf } from './expressions.js';
import { joined } from './syntax.js';
const KEYWORD_FORMS = {
    import: 'an import',
    export: 'an export',
    method: 'a method declaration',
    type: 'a type declaration',
    enum: 'an enum declaration',
    else: 'an else with no if before it',
};
const QUALIFIERS = new Set(['const', 'simple', 'series']);
const TYPES = new Set([
    'int', 'float', 'bool', 'color', 'string', 'line', 'label', 'box', 'table', 'linefill',
    'polyline', 'array', 'matrix', 'map',
]);
const ASSIGNMENTS = new Set([':=', '+=', '-=', '*=', '/=', '%=']);
function placeOfLogical(logical) {
    const first = logical.tokens[0];
    const last = logical.tokens[logical.tokens.length - 1];
    if (first === undefined || last === undefined)
        return { offset: 0, length: 0 };
    return joined(placeOf(first), placeOf(last));
}
/** The last input line a body reaches, or the fallback when it holds no code. */
function lastLineOf(body, fallback) {
    let last = fallback;
    for (const entry of body) {
        if (entry.kind === 'stmt')
            last = Math.max(last, entry.stmt.lines.last);
    }
    return last;
}
function nextCode(items, from) {
    for (let i = from; i < items.length; i += 1) {
        const item = items[i];
        if (item !== undefined && item.kind === 'code')
            return item.logical;
    }
    return undefined;
}
function entryOf(item) {
    if (item.kind === 'remark')
        return { kind: 'remark', remark: item.remark };
    if (item.kind === 'blank')
        return { kind: 'blank', line: item.line };
    return undefined;
}
/** The statements indented past a header at `headerIndent`, starting at item `from`. */
function blockAfter(items, from, headerIndent) {
    const body = [];
    let i = from;
    while (i < items.length) {
        const item = items[i];
        if (item === undefined)
            break;
        if (item.kind !== 'code') {
            const code = nextCode(items, i);
            if (code === undefined || code.indent <= headerIndent)
                break;
            const entry = entryOf(item);
            if (entry !== undefined)
                body.push(entry);
            i += 1;
            continue;
        }
        if (item.logical.indent <= headerIndent)
            break;
        const parsed = statementAt(items, i, item.logical);
        body.push({ kind: 'stmt', stmt: parsed.stmt });
        i = parsed.next;
    }
    return { body, next: i };
}
/** The whole file as one top level body. */
export function readScript(items) {
    return blockAfter(items, 0, -1).body;
}
/** Names a statement the reader refused would have declared, read off its first tokens. */
function declaredBy(tokens) {
    let i = 0;
    const at = (k) => tokens[k];
    if (at(i)?.text === 'var' || at(i)?.text === 'varip')
        i += 1;
    while (at(i) !== undefined && (QUALIFIERS.has(at(i)?.text ?? '') || TYPES.has(at(i)?.text ?? '')))
        i += 1;
    const head = at(i);
    if (head === undefined)
        return [];
    if (head.kind === 'name' && at(i + 1)?.text === '=')
        return [{ name: head.text, at: placeOf(head) }];
    if (head.text === '[') {
        const names = [];
        for (let k = i + 1; k < tokens.length; k += 1) {
            const token = tokens[k];
            if (token === undefined || token.text === ']')
                break;
            if (token.kind === 'name')
                names.push({ name: token.text, at: placeOf(token) });
        }
        return names;
    }
    if (head.kind === 'name' && at(i + 1)?.text === '(') {
        if (tokens.some((token) => token.text === '=>'))
            return [{ name: head.text, at: placeOf(head) }];
    }
    return [];
}
/** A statement kept whole, with the block below it swallowed so its lines stay together. */
function refusedAt(items, index, logical, at, construct) {
    const { body, next } = blockAfter(items, index + 1, logical.indent);
    const lines = { first: logical.firstLine, last: lastLineOf(body, logical.lastLine) };
    const stmt = { kind: 'refused', construct, declares: declaredBy(logical.tokens), at, lines, remarks: logical.remarks };
    return { stmt, next };
}
/** The statement starting at item `index`, whose logical line is `logical`. */
function statementAt(items, index, logical) {
    try {
        return statementOf(items, index, logical);
    }
    catch (error) {
        if (!(error instanceof Unreadable))
            throw error;
        return refusedAt(items, index, logical, error.at, error.construct);
    }
}
function common(logical, last = logical.lastLine) {
    return { at: placeOfLogical(logical), lines: { first: logical.firstLine, last }, remarks: logical.remarks };
}
function wholeLine(c) {
    if (!c.done())
        c.fail();
}
function statementOf(items, index, logical) {
    const c = new Cursor(logical.tokens);
    const first = c.peek();
    if (first === undefined)
        throw new Unreadable(placeOfLogical(logical), UNREAD);
    if (first.kind === 'bad')
        throw new Unreadable(placeOf(first), badConstruct(first));
    const word = first.kind === 'name' ? first.text : '';
    const keyword = KEYWORD_FORMS[word];
    if (keyword !== undefined)
        throw new Unreadable(placeOf(first), keyword);
    switch (word) {
        case 'if':
            return ifAt(items, index, logical, c);
        case 'for':
            return forAt(items, index, logical, c);
        case 'while': {
            c.take();
            const condition = expression(c);
            wholeLine(c);
            const { body, next } = blockAfter(items, index + 1, logical.indent);
            return { stmt: { kind: 'while', condition, body, ...common(logical, lastLineOf(body, logical.lastLine)) }, next };
        }
        case 'switch':
            return switchAt(items, index, logical, c);
        case 'break':
        case 'continue':
            c.take();
            wholeLine(c);
            return { stmt: { kind: word, ...common(logical) }, next: index + 1 };
    }
    return simpleAt(items, index, logical, c);
}
function ifAt(items, index, logical, c) {
    c.take();
    const branches = [];
    let condition = expression(c);
    wholeLine(c);
    let { body, next } = blockAfter(items, index + 1, logical.indent);
    let otherwise;
    let last = lastLineOf(body, logical.lastLine);
    for (;;) {
        branches.push({ condition, body });
        // Comment and blank lines before an else belong to the branch they follow.
        let ahead = next;
        const between = [];
        for (let item = items[ahead]; item !== undefined && item.kind !== 'code'; item = items[++ahead]) {
            const entry = entryOf(item);
            if (entry !== undefined)
                between.push(entry);
        }
        const following = items[ahead];
        if (following === undefined || following.kind !== 'code')
            break;
        const line = following.logical;
        if (line.indent !== logical.indent || line.tokens[0]?.text !== 'else')
            break;
        body.push(...between);
        next = ahead;
        const tail = new Cursor(line.tokens);
        tail.take();
        if (tail.done()) {
            const block = blockAfter(items, next + 1, logical.indent);
            otherwise = block.body;
            last = lastLineOf(block.body, line.lastLine);
            next = block.next;
            break;
        }
        tail.expect('if');
        condition = expression(tail);
        wholeLine(tail);
        const block = blockAfter(items, next + 1, logical.indent);
        body = block.body;
        last = lastLineOf(block.body, line.lastLine);
        next = block.next;
    }
    return { stmt: { kind: 'if', branches, otherwise, ...common(logical, last) }, next };
}
function forAt(items, index, logical, c) {
    const head = c.take();
    const variable = c.take();
    if (variable.kind !== 'name' || c.sees('in')) {
        throw new Unreadable(joined(placeOf(head), placeOf(variable)), 'a for loop over a collection');
    }
    c.expect('=');
    const from = expression(c);
    c.expect('to');
    const to = expression(c);
    let by;
    if (c.sees('by')) {
        c.take();
        by = expression(c);
    }
    wholeLine(c);
    const { body, next } = blockAfter(items, index + 1, logical.indent);
    const named = { name: variable.text, at: placeOf(variable) };
    const stmt = { kind: 'for', variable: named, from, to, by, body, ...common(logical, lastLineOf(body, logical.lastLine)) };
    return { stmt, next };
}
function switchAt(items, index, logical, c) {
    c.take();
    const subject = c.done() ? undefined : expression(c);
    wholeLine(c);
    const arms = [];
    // Comment and blank lines between arms stay with the arm before them, and
    // any before the first arm go at the start of its body.
    const pending = [];
    let i = index + 1;
    let last = logical.lastLine;
    while (i < items.length) {
        const item = items[i];
        if (item === undefined)
            break;
        if (item.kind !== 'code') {
            const code = nextCode(items, i);
            if (code === undefined || code.indent <= logical.indent)
                break;
            const entry = entryOf(item);
            if (entry !== undefined)
                (arms[arms.length - 1]?.body ?? pending).push(entry);
            i += 1;
            continue;
        }
        const line = item.logical;
        if (line.indent <= logical.indent)
            break;
        const arm = new Cursor(line.tokens);
        const match = arm.sees('=>') ? undefined : expression(arm);
        arm.expect('=>');
        if (arm.done()) {
            const block = blockAfter(items, i + 1, line.indent);
            arms.push({ match, body: [...pending.splice(0), ...block.body] });
            last = lastLineOf(block.body, line.lastLine);
            i = block.next;
            continue;
        }
        const rest = { ...line, tokens: line.tokens.slice(arm.index) };
        const inner = simpleAt(items, i, rest, new Cursor(rest.tokens));
        arms.push({ match, body: [...pending.splice(0), { kind: 'stmt', stmt: inner.stmt }] });
        last = line.lastLine;
        i += 1;
    }
    const read = arms;
    return { stmt: { kind: 'switch', subject, arms: read, ...common(logical, last) }, next: i };
}
/** Skips `var`, qualifiers and a type; returns the mode and whether a type was written. */
function declarationHead(c) {
    let mode = 'plain';
    if (c.sees('var') || c.sees('varip'))
        mode = c.take().text === 'var' ? 'var' : 'varip';
    let typed = false;
    while (c.peek()?.kind === 'name' && QUALIFIERS.has(c.peek()?.text ?? ''))
        c.take();
    const type = c.peek();
    if (type !== undefined && type.kind === 'name' && TYPES.has(type.text)) {
        const after = c.peek(1);
        const generic = after?.text === '<';
        if (generic || (after?.kind === 'name' && after.text !== 'and' && after.text !== 'or')) {
            c.take();
            typed = true;
            if (generic) {
                while (!c.done() && !c.sees('>'))
                    c.take();
                c.expect('>');
            }
        }
    }
    return { mode, typed };
}
function simpleAt(items, index, logical, c) {
    const next = index + 1;
    const { mode, typed } = declarationHead(c);
    const head = c.peek();
    if (head === undefined)
        c.fail();
    if (head.text === '[' && mode === 'plain' && !typed)
        return tupleAt(index, logical, c);
    if (head.kind === 'name' && c.sees('(', 1) && mode === 'plain' && !typed) {
        const fn = functionAt(items, index, logical, c);
        if (fn !== undefined)
            return fn;
    }
    if (head.kind === 'name' && c.sees('=', 1)) {
        c.take();
        c.take();
        const valueStart = c.peek();
        if (valueStart !== undefined && (valueStart.text === 'if' || valueStart.text === 'switch')) {
            return valueFormAt(items, index, logical, valueStart);
        }
        const value = expression(c);
        wholeLine(c);
        const name = { name: head.text, at: placeOf(head) };
        return { stmt: { kind: 'declare', mode, name, value, ...common(logical) }, next };
    }
    if (mode !== 'plain' || typed)
        c.fail();
    if (head.kind === 'name' && c.peek(1)?.kind === 'op' && ASSIGNMENTS.has(c.peek(1)?.text ?? '')) {
        c.take();
        const op = c.take().text;
        const value = expression(c);
        wholeLine(c);
        const name = { name: head.text, at: placeOf(head) };
        return { stmt: { kind: 'assign', op, name, value, ...common(logical) }, next };
    }
    const expr = expression(c);
    wholeLine(c);
    return { stmt: { kind: 'evaluate', expr, ...common(logical) }, next };
}
/** `x = if ...` and `x = switch ...`, kept whole with every branch they own. */
function valueFormAt(items, index, logical, word) {
    const rest = { ...logical, tokens: logical.tokens.slice(logical.tokens.indexOf(word)) };
    const inner = word.text === 'if' ? ifAt(items, index, rest, new Cursor(rest.tokens)) : switchAt(items, index, rest, new Cursor(rest.tokens));
    const construct = word.text === 'if' ? 'an if used as a value' : 'a switch used as a value';
    const stmt = {
        kind: 'refused',
        construct,
        declares: declaredBy(logical.tokens),
        at: placeOf(word),
        lines: { first: logical.firstLine, last: inner.stmt.lines.last },
        remarks: logical.remarks,
    };
    return { stmt, next: inner.next };
}
function tupleAt(index, logical, c) {
    const open = c.take();
    const names = [];
    while (!c.sees(']')) {
        const token = c.take();
        if (token.kind !== 'name')
            throw new Unreadable(placeOf(token), UNREAD);
        names.push({ name: token.text, at: placeOf(token) });
        if (!c.sees(','))
            break;
        c.take();
    }
    const close = c.expect(']');
    if (!c.sees('='))
        throw new Unreadable(joined(placeOf(open), placeOf(close)), 'a tuple reassignment');
    c.take();
    const value = expression(c);
    wholeLine(c);
    return { stmt: { kind: 'tuple', names, value, ...common(logical) }, next: index + 1 };
}
/** A function declaration, or undefined when the line is a call rather than one. */
function functionAt(items, index, logical, c) {
    const tokens = logical.tokens;
    let depth = 0;
    let close = -1;
    for (let k = c.index + 1; k < tokens.length; k += 1) {
        const text = tokens[k]?.text;
        if (text === '(')
            depth += 1;
        else if (text === ')') {
            depth -= 1;
            if (depth === 0) {
                close = k;
                break;
            }
        }
    }
    if (close < 0 || tokens[close + 1]?.text !== '=>')
        return undefined;
    const nameToken = c.take();
    c.expect('(');
    const params = [];
    while (!c.sees(')')) {
        declarationHead(c);
        const token = c.take();
        if (token.kind !== 'name')
            throw new Unreadable(placeOf(token), UNREAD);
        let fallback;
        if (c.sees('=')) {
            c.take();
            fallback = expression(c);
        }
        params.push({ name: token.text, at: placeOf(token), fallback });
        if (!c.sees(','))
            break;
        c.take();
    }
    c.expect(')');
    c.expect('=>');
    const name = { name: nameToken.text, at: placeOf(nameToken) };
    if (!c.done()) {
        const body = expression(c);
        wholeLine(c);
        return { stmt: { kind: 'function', name, params, body, ...common(logical) }, next: index + 1 };
    }
    const block = blockAfter(items, index + 1, logical.indent);
    const stmt = {
        kind: 'function',
        name,
        params,
        body: block.body,
        ...common(logical, lastLineOf(block.body, logical.lastLine)),
    };
    return { stmt, next: block.next };
}
//# sourceMappingURL=parser.js.map