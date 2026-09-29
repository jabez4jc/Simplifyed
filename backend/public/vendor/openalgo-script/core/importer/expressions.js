import { joined } from './syntax.js';
/** A form the reader does not accept, and where it starts. */
export class Unreadable extends Error {
    at;
    construct;
    constructor(at, construct) {
        super(construct);
        this.at = at;
        this.construct = construct;
    }
}
/** Words that open a statement form and are never a value. */
const STATEMENT_WORDS = {
    if: 'an if used as a value',
    switch: 'a switch used as a value',
    for: 'a for loop used as a value',
    while: 'a while loop used as a value',
};
/** The words the reader takes for a form it does not read, per bad token. */
export function badConstruct(token) {
    if (token.text.startsWith('"') || token.text.startsWith("'"))
        return 'a string that is never closed';
    if (token.text.startsWith('#'))
        return `the colour literal ${token.text}`;
    return `the character ${token.text}`;
}
export const UNREAD = 'a statement in a form its reader does not accept';
export class Cursor {
    index = 0;
    tokens;
    constructor(tokens) {
        this.tokens = tokens;
    }
    peek(ahead = 0) {
        return this.tokens[this.index + ahead];
    }
    /** Whether the next token is this operator or word. */
    sees(text, ahead = 0) {
        const token = this.peek(ahead);
        return token !== undefined && (token.kind === 'op' || token.kind === 'name') && token.text === text;
    }
    done() {
        return this.index >= this.tokens.length;
    }
    take() {
        const token = this.tokens[this.index];
        if (token === undefined)
            throw new Unreadable(this.endPlace(), UNREAD);
        this.index += 1;
        return token;
    }
    expect(text) {
        if (!this.sees(text))
            this.fail();
        return this.take();
    }
    /** Refuse at the next token, or at the end of the line when there is none. */
    fail() {
        const token = this.peek();
        if (token === undefined)
            throw new Unreadable(this.endPlace(), UNREAD);
        if (token.kind === 'bad')
            throw new Unreadable(placeOf(token), badConstruct(token));
        throw new Unreadable(placeOf(token), UNREAD);
    }
    /** Zero width, just after the last token. */
    endPlace() {
        const last = this.tokens[this.tokens.length - 1];
        return last === undefined ? { offset: 0, length: 0 } : { offset: last.offset + last.length, length: 0 };
    }
}
export function placeOf(token) {
    return { offset: token.offset, length: token.length };
}
const COMPARISON = new Set(['<', '<=', '>', '>=']);
const EQUALITY = new Set(['==', '!=']);
const ADDITIVE = new Set(['+', '-']);
const MULTIPLICATIVE = new Set(['*', '/', '%']);
/** One left associative level of binary operators. */
function binaryLevel(operators, next, words = false) {
    return (c) => {
        let left = next(c);
        for (;;) {
            const token = c.peek();
            if (token === undefined || !operators.has(token.text))
                return left;
            if (words ? token.kind !== 'name' : token.kind !== 'op')
                return left;
            c.take();
            const right = next(c);
            left = { kind: 'binary', op: token.text, left, right, at: joined(left.at, right.at), opAt: placeOf(token) };
        }
    };
}
export function expression(c) {
    return ternary(c);
}
function ternary(c) {
    const condition = orLevel(c);
    if (!c.sees('?'))
        return condition;
    c.take();
    const then = ternary(c);
    c.expect(':');
    const otherwise = ternary(c);
    return { kind: 'ternary', condition, then, otherwise, at: joined(condition.at, otherwise.at) };
}
function unary(c) {
    const token = c.peek();
    if (token !== undefined) {
        const sign = token.kind === 'op' && (token.text === '-' || token.text === '+');
        const not = token.kind === 'name' && token.text === 'not';
        if (sign || not) {
            c.take();
            const operand = unary(c);
            return { kind: 'unary', op: token.text, operand, at: joined(placeOf(token), operand.at) };
        }
    }
    return postfix(c);
}
const multiplicative = binaryLevel(MULTIPLICATIVE, unary);
const additive = binaryLevel(ADDITIVE, multiplicative);
const comparison = binaryLevel(COMPARISON, additive);
const equality = binaryLevel(EQUALITY, comparison);
const andLevel = binaryLevel(new Set(['and']), equality, true);
const orLevel = binaryLevel(new Set(['or']), andLevel, true);
function argumentsOf(c) {
    const args = [];
    if (c.sees(')'))
        return args;
    for (;;) {
        const first = c.peek();
        let label;
        if (first !== undefined && first.kind === 'name' && c.sees('=', 1)) {
            label = first.text;
            c.take();
            c.take();
        }
        const value = expression(c);
        args.push({ label, value, at: first === undefined ? value.at : joined(placeOf(first), value.at) });
        if (!c.sees(','))
            return args;
        c.take();
    }
}
function postfix(c) {
    let expr = primary(c);
    for (;;) {
        if (c.sees('(')) {
            c.take();
            const args = argumentsOf(c);
            const close = c.expect(')');
            expr = { kind: 'call', callee: expr, args, at: joined(expr.at, placeOf(close)) };
        }
        else if (c.sees('[')) {
            c.take();
            const index = expression(c);
            const close = c.expect(']');
            expr = { kind: 'index', target: expr, index, at: joined(expr.at, placeOf(close)) };
        }
        else if (c.sees('.')) {
            c.take();
            const property = c.take();
            if (property.kind !== 'name')
                throw new Unreadable(placeOf(property), UNREAD);
            expr = { kind: 'member', object: expr, property: property.text, at: joined(expr.at, placeOf(property)) };
        }
        else {
            return expr;
        }
    }
}
function primary(c) {
    const token = c.peek();
    if (token === undefined)
        c.fail();
    const at = placeOf(token);
    switch (token.kind) {
        case 'number':
            c.take();
            return { kind: 'number', text: token.text, at };
        case 'string':
            c.take();
            return { kind: 'string', value: token.value, at };
        case 'color':
            c.take();
            return { kind: 'color', text: token.text, at };
        case 'bad':
            throw new Unreadable(at, badConstruct(token));
        case 'name': {
            const word = STATEMENT_WORDS[token.text];
            if (word !== undefined)
                throw new Unreadable(at, word);
            c.take();
            if (token.text === 'true' || token.text === 'false') {
                return { kind: 'bool', value: token.text === 'true', at };
            }
            return { kind: 'name', name: token.text, at };
        }
        case 'op':
            break;
    }
    if (token.text === '(') {
        c.take();
        const inner = expression(c);
        const close = c.expect(')');
        return { kind: 'group', inner, at: joined(at, placeOf(close)) };
    }
    if (token.text === '[') {
        c.take();
        const items = [];
        while (!c.sees(']')) {
            items.push(expression(c));
            if (!c.sees(','))
                break;
            c.take();
        }
        const close = c.expect(']');
        return { kind: 'list', items, at: joined(at, placeOf(close)) };
    }
    return c.fail();
}
//# sourceMappingURL=expressions.js.map