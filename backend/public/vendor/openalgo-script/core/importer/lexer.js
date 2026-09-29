/** The width of one block in the dialect, which a continuation is indented off. */
const BLOCK = 4;
const TWO_CHARACTER = [':=', '==', '!=', '<=', '>=', '=>', '+=', '-=', '*=', '/=', '%='];
const ONE_CHARACTER = '+-*/%<>=?:,.()[]';
/** Tokens after which a statement cannot end, so the next indented line continues it. */
const CONTINUES = new Set([
    ',', '+', '-', '*', '/', '%', '==', '!=', '<', '<=', '>', '>=', '?', ':', ':=', '=',
    '+=', '-=', '*=', '/=', '%=', 'and', 'or', 'not', '(', '[',
]);
const NAME_START = /[A-Za-z_]/;
const NAME_PART = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;
const HEX = /[0-9A-Fa-f]/;
const ESCAPES = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"' };
/** Columns of leading whitespace, and where the text after it starts. */
function measure(text) {
    let indent = 0;
    let start = 0;
    while (start < text.length) {
        const c = text[start];
        if (c === ' ')
            indent += 1;
        else if (c === '\t')
            indent += BLOCK - (indent % BLOCK);
        else
            break;
        start += 1;
    }
    return { indent, start };
}
function readString(text, at) {
    const quote = text[at];
    let value = '';
    let i = at + 1;
    while (i < text.length) {
        const c = text[i] ?? '';
        if (c === quote)
            return { end: i + 1, value, closed: true };
        if (c === '\\' && i + 1 < text.length) {
            const next = text[i + 1] ?? '';
            value += ESCAPES[next] ?? next;
            i += 2;
            continue;
        }
        value += c;
        i += 1;
    }
    return { end: text.length, value, closed: false };
}
function readNumber(text, at) {
    let i = at;
    while (i < text.length && DIGIT.test(text[i] ?? ''))
        i += 1;
    if (text[i] === '.' && !NAME_START.test(text[i + 1] ?? '')) {
        i += 1;
        while (i < text.length && DIGIT.test(text[i] ?? ''))
            i += 1;
    }
    if ((text[i] === 'e' || text[i] === 'E') && /[0-9+-]/.test(text[i + 1] ?? '')) {
        let j = i + 1;
        if (text[j] === '+' || text[j] === '-')
            j += 1;
        if (DIGIT.test(text[j] ?? '')) {
            i = j;
            while (i < text.length && DIGIT.test(text[i] ?? ''))
                i += 1;
        }
    }
    return i;
}
/** Every token on one physical line, and the comment that ends it if any. */
function tokensOf(text, start, lineStart, line) {
    const tokens = [];
    const token = (kind, from, to, value) => {
        const written = text.slice(from, to);
        tokens.push({ kind, text: written, value: value ?? written, offset: lineStart + from, length: to - from });
    };
    let i = start;
    while (i < text.length) {
        const c = text[i] ?? '';
        if (c === ' ' || c === '\t') {
            i += 1;
            continue;
        }
        if (c === '/' && text[i + 1] === '/') {
            return { tokens, remark: { text: text.slice(i + 2).trimEnd(), offset: lineStart + i, line } };
        }
        if (NAME_START.test(c)) {
            let j = i + 1;
            while (j < text.length && NAME_PART.test(text[j] ?? ''))
                j += 1;
            token('name', i, j);
            i = j;
            continue;
        }
        if (DIGIT.test(c) || (c === '.' && DIGIT.test(text[i + 1] ?? ''))) {
            const j = readNumber(text, i);
            token('number', i, j);
            i = j;
            continue;
        }
        if (c === '"' || c === "'") {
            const read = readString(text, i);
            token(read.closed ? 'string' : 'bad', i, read.end, read.value);
            i = read.end;
            continue;
        }
        if (c === '#') {
            let j = i + 1;
            while (j < text.length && HEX.test(text[j] ?? ''))
                j += 1;
            token(j - i === 7 || j - i === 9 ? 'color' : 'bad', i, j);
            i = j;
            continue;
        }
        const pair = text.slice(i, i + 2);
        if (TWO_CHARACTER.includes(pair)) {
            token('op', i, i + 2);
            i += 2;
            continue;
        }
        token(ONE_CHARACTER.includes(c) ? 'op' : 'bad', i, i + 1);
        i += 1;
    }
    return { tokens, remark: undefined };
}
/** How far a line's brackets leave the statement open. */
function depthAfter(depth, tokens) {
    let open = depth;
    for (const one of tokens) {
        if (one.kind !== 'op')
            continue;
        if (one.text === '(' || one.text === '[')
            open += 1;
        else if (one.text === ')' || one.text === ']')
            open = Math.max(0, open - 1);
    }
    return open;
}
function continues(current, next) {
    if (current.depth > 0)
        return true;
    if (next.indent <= current.indent)
        return false;
    if (next.indent % BLOCK !== 0)
        return true;
    const last = current.tokens[current.tokens.length - 1];
    return last !== undefined && CONTINUES.has(last.text);
}
/**
 * The whole file as items: statements, comment lines and blank lines, in order.
 *
 * A comment line or a blank line inside an open statement belongs to that
 * statement and ends nothing, the same rule OpenScript gives them.
 */
export function readItems(file) {
    const items = [];
    let current;
    const held = [];
    const close = () => {
        if (current === undefined)
            return;
        const { indent, tokens, remarks, firstLine, lastLine } = current;
        items.push({ kind: 'code', logical: { indent, tokens, remarks, firstLine, lastLine } });
        current = undefined;
    };
    for (let line = 1; line <= file.lineCount; line += 1) {
        const text = file.lineText(line);
        const { indent, start } = measure(text);
        const read = tokensOf(text, start, file.lineStart(line), line);
        const physical = { line, indent, tokens: read.tokens, remark: read.remark };
        if (physical.tokens.length === 0) {
            if (current !== undefined && current.depth > 0) {
                if (physical.remark !== undefined)
                    current.remarks.push(physical.remark);
                continue;
            }
            held.push(physical.remark === undefined
                ? { kind: 'blank', line }
                : { kind: 'remark', remark: physical.remark, indent });
            continue;
        }
        if (current !== undefined && continues(current, physical)) {
            current.tokens.push(...physical.tokens);
            if (physical.remark !== undefined)
                current.remarks.push(physical.remark);
            current.lastLine = line;
            current.depth = depthAfter(current.depth, physical.tokens);
            continue;
        }
        close();
        items.push(...held);
        held.length = 0;
        current = {
            indent,
            tokens: [...physical.tokens],
            remarks: physical.remark === undefined ? [] : [physical.remark],
            firstLine: line,
            lastLine: line,
            depth: depthAfter(0, physical.tokens),
        };
    }
    close();
    items.push(...held);
    return items;
}
//# sourceMappingURL=lexer.js.map