import { withoutGrouping } from '../ast/index.js';
import { endOffset } from '../span/index.js';
import { elementOf } from '../check/index.js';
import { emitCall, emitLibraryValue } from './calls.js';
import { hexColour } from './colours.js';
import { placementOf, registerOfName, shadowRegister } from './registers.js';
const ARITHMETIC = {
    '+': 'ADD',
    '-': 'SUB',
    '*': 'MUL',
    '/': 'DIV',
    '%': 'MOD',
};
/** A line comment, which is the only thing that can hide an operator token. */
const COMMENT = /\/\/[^\r\n]*/g;
const COMPARISON = {
    '<': 'LT',
    '<=': 'LE',
    '>': 'GT',
    '>=': 'GE',
    '==': 'EQ',
    '!=': 'NE',
};
export function emitExpression(e, f, expression) {
    const node = withoutGrouping(expression);
    f.builder.at(node.span);
    switch (node.kind) {
        case 'numberLiteral':
            f.builder.push('CONST', e.pool.number(node.value));
            return;
        case 'stringLiteral':
            f.builder.push('CONST', e.pool.string(node.value));
            return;
        case 'booleanLiteral':
            f.builder.push('CONST', e.pool.bool(node.value));
            return;
        case 'noneLiteral':
        case 'missingExpression':
            f.builder.push('CONST', e.pool.absent());
            return;
        case 'colorLiteral': {
            const colour = hexColour(node.text);
            f.builder.push('CONST', colour === undefined ? e.pool.absent() : e.pool.colour(colour));
            return;
        }
        case 'arrayLiteral':
            // A new array on every evaluation, which is why it is never pooled (2.9).
            for (const element of node.elements)
                emitExpression(e, f, element);
            f.builder.at(node.span);
            f.builder.push('ARRAY', node.elements.length);
            return;
        case 'nameReference':
            emitNameRead(e, f, node);
            return;
        case 'member':
            emitLibraryValue(e, f, node);
            return;
        case 'unary': {
            emitExpression(e, f, node.operand);
            f.builder.at(node.span);
            // There is no instruction for unary plus: on a number it is the identity
            // and its type is already checked, so it compiles to nothing at all (4.5).
            if (node.operator === '-')
                f.builder.push('NEG');
            else if (node.operator === 'not')
                f.builder.push('NOT');
            return;
        }
        case 'binary':
            emitBinary(e, f, node);
            return;
        case 'ternary': {
            emitExpression(e, f, node.condition);
            f.builder.at(node.span);
            const toElse = f.builder.push('JUMP_FALSE', 0);
            emitExpression(e, f, node.whenTrue);
            f.builder.at(node.span);
            const toEnd = f.builder.push('JUMP', 0);
            f.builder.patch(toElse, 0, f.builder.here);
            emitExpression(e, f, node.whenFalse);
            f.builder.patch(toEnd, 0, f.builder.here);
            return;
        }
        case 'call':
            emitCall(e, f, node);
            return;
        case 'index':
            emitIndex(e, f, node);
            return;
    }
}
/**
 * Where an operator's instruction is said to be, for `debug.pos`.
 *
 * The caret an engine draws for a runtime error comes from this table, and 12.2
 * puts a `GT` under the `>` and an `ADD` under the `+` rather than under the
 * start of the expression they are part of. The tree carries no span for the
 * operator token, so it is found in the gap between the two operands, where the
 * only thing that can stand between them is a comment or a line continuation.
 */
function operatorAt(e, node) {
    const from = endOffset(node.left.span);
    const to = node.right.span.offset;
    const gap = e.file.text.slice(from, to);
    const cleaned = gap.replace(COMMENT, (match) => ' '.repeat(match.length));
    const found = cleaned.indexOf(node.operator);
    return found < 0 ? node.span : e.file.spanAt(from + found, node.operator.length);
}
function emitBinary(e, f, node) {
    const operator = operatorAt(e, node);
    if (node.operator === 'and' || node.operator === 'or') {
        // Each operator short-circuits on the one value that decides the answer by
        // itself and leaves it on the stack; absence short-circuits neither,
        // because the other side can still decide (4.7).
        emitExpression(e, f, node.left);
        f.builder.at(operator);
        const short = f.builder.push(node.operator === 'and' ? 'AND_SHORT' : 'OR_SHORT', 0);
        emitExpression(e, f, node.right);
        f.builder.at(operator);
        f.builder.push(node.operator === 'and' ? 'AND' : 'OR');
        f.builder.patch(short, 0, f.builder.here);
        return;
    }
    emitExpression(e, f, node.left);
    emitExpression(e, f, node.right);
    f.builder.at(operator);
    const arithmetic = ARITHMETIC[node.operator];
    if (arithmetic !== undefined) {
        f.builder.push(arithmetic);
        return;
    }
    const comparison = COMPARISON[node.operator];
    if (comparison !== undefined)
        f.builder.push(comparison);
}
/** Where a name's value lives, which the checker decided and this reads off. */
export function emitNameRead(e, f, node) {
    const binding = e.bindingAt(node);
    if (binding === undefined) {
        emitLibraryValue(e, f, node);
        return;
    }
    emitBindingRead(e, f, binding, node.span);
}
export function emitBindingRead(e, f, binding, at) {
    f.builder.at(at);
    // Inside a read's expression a setting is a register of the body's own table
    // (2.16), reachable from the body and from any function it calls. The only
    // other file-scope name admitted there is OS6003, which the checker reported.
    const setting = e.request?.registerFor(e, binding);
    if (setting !== undefined) {
        f.builder.push('SLOAD', setting);
        return;
    }
    const placement = placementOf(e, binding);
    if (placement === 'cell') {
        if (!f.layout.hasCellFor(binding) && !f.topLevel) {
            // A frame reaches its own cells through its base, so a body cannot name
            // a cell of the frame that called it (2.11, 3.3). The register beside the
            // cell is what it reads instead, and `registers.ts` says how it is filled.
            const carried = e.carried.has(binding.id) ? e.layout.registerFor(binding) : undefined;
            if (carried !== undefined) {
                f.builder.push('SLOAD', carried);
                return;
            }
            e.gap('a function body reads a `var` declared at the file scope, and a cell operand is ' +
                "relative to the frame's cellBase, so no instruction can reach it", 'compiled-program.md 2.11 and 3.3, against language.md 12.2', at, true);
            f.builder.push('CONST', e.pool.absent());
            return;
        }
        f.builder.push('LOADC', f.layout.cellFor(binding));
        return;
    }
    if (placement === 'register') {
        f.builder.push('SLOAD', e.layout.computedFor(binding));
        return;
    }
    f.builder.push('LOAD', f.layout.slotFor(binding));
}
/**
 * `target[index]`: an element of an array, or a value some bars back.
 *
 * The checker has already decided which of the two this is, from the target's
 * type, so there is no run-time dispatch and no third meaning (`language.md`
 * 9.6). What is left is where the history comes from, and only a register has
 * any (2.10).
 */
function emitIndex(e, f, node) {
    const type = e.checked.types.get(node.target);
    if (type !== undefined && elementOf(type).kind === 'array') {
        emitExpression(e, f, node.target);
        emitExpression(e, f, node.index);
        f.builder.at(node.span);
        f.builder.push('ELEM');
        return;
    }
    const target = withoutGrouping(node.target);
    if (target.kind === 'nameReference') {
        const binding = e.bindingAt(target);
        if (binding !== undefined) {
            const parameter = f.parameters.get(binding.id);
            if (parameter !== undefined) {
                emitExpression(e, f, node.index);
                f.builder.at(node.span);
                f.builder.push('HISTP', parameter);
                return;
            }
            emitExpression(e, f, node.index);
            f.builder.at(node.span);
            f.builder.push('HIST', shadowRegister(e, binding));
            return;
        }
        const register = registerOfName(e, target.name);
        if (register !== undefined) {
            emitExpression(e, f, node.index);
            f.builder.at(node.span);
            f.builder.push('HIST', register);
            return;
        }
    }
    if (target.kind === 'member') {
        const register = registerOfName(e, memberText(target));
        if (register !== undefined) {
            emitExpression(e, f, node.index);
            f.builder.at(node.span);
            f.builder.push('HIST', register);
            return;
        }
    }
    // Anything else with history is a call or a namespace read the language
    // allows `[]` on (`language.md` 5.2). The format has no register kind for an
    // expression that is not a name, so one is allocated as a `computed` and the
    // value is written to it where it is produced. That is the honest reading of
    // 2.10 and not a spelling it states.
    e.gap('a history read of an expression that is not a name needs a register, and 2.10 names ' +
        'a computed register for a top-level name only', 'compiled-program.md 2.10', node.span, false);
    const register = e.layout.computed(textOf(e, node.target));
    emitExpression(e, f, node.target);
    f.builder.at(node.span);
    f.builder.push('SSTORE', register);
    emitExpression(e, f, node.index);
    f.builder.at(node.span);
    f.builder.push('HIST', register);
}
function memberText(node) {
    const object = withoutGrouping(node.object);
    return object.kind === 'nameReference' ? `${object.name}.${node.member.text}` : node.member.text;
}
function textOf(e, expression) {
    return e.file.text.slice(expression.span.offset, expression.span.offset + expression.span.length);
}
//# sourceMappingURL=expressions.js.map