/**
 * Checks 2 to 7 of `compiled-program.md` 3.5, over one instruction list.
 *
 * Verification is not optional and not a debug mode. An engine that skips it
 * can be handed a malformed list and will read past the end of an array or jump
 * into the middle of an expression, and the failure will look like a wrong
 * number rather than a broken program. What these five checks buy is stated in
 * the specification and is worth restating here, because it is what the engine
 * is then allowed to assume and therefore not to test: a verified program
 * cannot underflow the stack, cannot jump out of bounds, cannot address a slot
 * that does not exist and cannot loop without charging the budget.
 *
 * Check 6 is the one that looks small and is not. The target of every backward
 * jump must be a `TICK`, so no cycle in the control flow graph can run without
 * charging the loop budget, and the whole of that guarantee is checkable by
 * looking at one instruction rather than by analysing the graph.
 */
import { depthChange, isOpcode, operandCount, targetPositions } from '../emit/index.js';
import { atInstruction } from './errors.js';
/** Which table each opcode's operands index, by position. */
const OPERAND_TABLES = {
    CONST: ['consts'],
    LOAD: ['slots'],
    STORE: ['slots'],
    CELL_INIT: ['cells', 'target'],
    LOADC: ['cells'],
    STOREC: ['cells'],
    SLOAD: ['registers'],
    SSTORE: ['registers'],
    HIST: ['registers'],
    HISTP: ['series'],
    AND_SHORT: ['target'],
    OR_SHORT: ['target'],
    JUMP: ['target'],
    JUMP_FALSE: ['target'],
    TICK: ['loops'],
    FOR_INIT: ['loops', 'slots', 'slots', 'slots', 'target'],
    FOR_NEXT: ['loops', 'slots', 'slots', 'slots', 'target'],
    ARRAY: ['count'],
    CALL_LIB: ['libFunctions', 'count', 'states'],
    CALL_FN: ['callSites'],
    EMIT: ['channels'],
};
const TABLE_NAMES = {
    slots: 'the frame',
    cells: 'cells',
    states: 'states',
    registers: 'series',
    channels: 'channels',
    libFunctions: 'lib.functions',
    callSites: 'callSites',
    loops: 'loops',
    consts: 'consts',
    series: "the call site's series bindings",
};
/**
 * Walks one instruction list.
 *
 * `terminator` is `HALT` for the bar's own code and `RET` for a function body,
 * which is check 4, and the depth at it must be zero, which is check 5.
 */
export function checkList(shape, list, code, limits, terminator) {
    if (code.length === 0)
        return shape.fail(list, 'an instruction list cannot be empty');
    // Check 2, and every operand in range.
    for (let i = 0; i < code.length; i += 1) {
        const instruction = code[i];
        const where = atInstruction(list, i);
        if (!shape.array(instruction, where))
            return false;
        const opcode = instruction[0];
        if (typeof opcode !== 'string' || !isOpcode(opcode)) {
            return shape.fail(where, `${String(opcode)} is not an opcode this engine implements`);
        }
        const operands = instruction.slice(1);
        if (operands.length !== operandCount(opcode)) {
            return shape.fail(where, `${opcode} takes ${operandCount(opcode)} operands and carries ${operands.length}`);
        }
        const tables = OPERAND_TABLES[opcode] ?? [];
        for (let k = 0; k < operands.length; k += 1) {
            const operand = operands[k];
            if (!shape.whole(operand, `${where} operand ${k}`))
                return false;
            const table = tables[k];
            if (table === undefined || table === 'count') {
                if (operand < 0) {
                    return shape.fail(`${where} operand ${k}`, 'a count cannot be negative');
                }
                continue;
            }
            if (table === 'target') {
                // Check 3. A target past the terminator is out of the list.
                if (operand < 0 || operand >= code.length) {
                    return shape.fail(where, `the jump target ${operand} is outside a list of ${code.length}`);
                }
                continue;
            }
            // A `CALL_LIB` with no state carries -1 rather than an index.
            if (opcode === 'CALL_LIB' && table === 'states' && operand === -1)
                continue;
            // A series binding a call site left unbound is -1 and no `HISTP` may reach it.
            const size = limits[table];
            if (typeof size !== 'number')
                continue;
            if (operand < 0 || operand >= size) {
                return shape.fail(`${where} operand ${k}`, `${operand} is outside ${TABLE_NAMES[table] ?? table}, which holds ${size}`);
            }
        }
        // Check 6: the target of a backward jump is a `TICK`.
        for (const position of targetPositions(opcode)) {
            const target = operands[position];
            if (typeof target !== 'number' || target > i)
                continue;
            const landing = code[target];
            if (!Array.isArray(landing) || landing[0] !== 'TICK') {
                return shape.fail(where, `it jumps back to instruction ${target}, which is not a TICK, so the loop would ` +
                    'run without charging the budget');
            }
        }
    }
    // Check 4.
    const last = code[code.length - 1];
    if (!Array.isArray(last) || last[0] !== terminator) {
        return shape.fail(atInstruction(list, code.length - 1), `the last instruction of this list must be ${terminator}`);
    }
    for (let i = 0; i < code.length - 1; i += 1) {
        const opcode = code[i]?.[0];
        if (opcode === 'HALT') {
            return shape.fail(atInstruction(list, i), 'HALT is only ever the last instruction');
        }
    }
    return checkDepths(shape, list, code, limits, terminator);
}
/**
 * Check 5: the stack depth agrees on every path, never goes below zero, and is
 * zero at the terminator.
 *
 * A disagreement at a join is a corrupt program, not a program with an unusual
 * shape: every instruction has a fixed effect, so two paths reaching one
 * instruction with different depths means one of them was built wrong.
 */
function checkDepths(shape, list, code, limits, terminator) {
    const depths = new Array(code.length).fill(undefined);
    const pending = [0];
    depths[0] = 0;
    const reach = (index, depth, from) => {
        if (depth < 0) {
            return shape.fail(atInstruction(list, from), 'it takes the stack below zero');
        }
        const known = depths[index];
        if (known === undefined) {
            depths[index] = depth;
            pending.push(index);
            return true;
        }
        if (known !== depth) {
            return shape.fail(atInstruction(list, index), `two paths reach it with the stack ${known} and ${depth} deep`);
        }
        return true;
    };
    while (pending.length > 0) {
        const index = pending.pop();
        if (index === undefined)
            continue;
        const instruction = code[index];
        const depth = depths[index];
        if (instruction === undefined || depth === undefined)
            continue;
        const opcode = instruction[0];
        const operands = instruction.slice(1);
        const after = depth + depthChange(opcode, operands, (site) => limits.argcOf(site));
        if (opcode === terminator) {
            if (after !== 0) {
                return shape.fail(atInstruction(list, index), `the stack is ${after} deep at ${terminator} and must be empty`);
            }
            continue;
        }
        for (const position of targetPositions(opcode)) {
            const target = operands[position];
            if (typeof target === 'number' && !reach(target, after, index))
                return false;
        }
        if (opcode !== 'JUMP' && opcode !== 'RET' && opcode !== 'HALT') {
            if (!reach(index + 1, after, index))
                return false;
        }
    }
    return true;
}
/**
 * Check 7: every channel declared `once` is written exactly once on every path
 * from instruction 0 to `HALT`.
 *
 * That is how a plot column is guaranteed a value, or an explicit absence, for
 * every bar. The counts are capped at two, because "more than once" is the whole
 * of what the check needs to know and a loop would otherwise never settle.
 */
export function checkOnce(shape, code, once) {
    const channels = once.length;
    if (channels === 0)
        return true;
    const cap = 2;
    const least = new Array(code.length).fill(undefined);
    const most = new Array(code.length).fill(undefined);
    const pending = [0];
    least[0] = new Array(channels).fill(0);
    most[0] = new Array(channels).fill(0);
    const merge = (index, low, high) => {
        if (index < 0 || index >= code.length)
            return;
        const knownLow = least[index];
        const knownHigh = most[index];
        if (knownLow === undefined || knownHigh === undefined) {
            least[index] = [...low];
            most[index] = [...high];
            pending.push(index);
            return;
        }
        let changed = false;
        for (let c = 0; c < channels; c += 1) {
            const lower = Math.min(knownLow[c] ?? 0, low[c] ?? 0);
            const upper = Math.min(cap, Math.max(knownHigh[c] ?? 0, high[c] ?? 0));
            if (lower !== knownLow[c]) {
                knownLow[c] = lower;
                changed = true;
            }
            if (upper !== knownHigh[c]) {
                knownHigh[c] = upper;
                changed = true;
            }
        }
        if (changed)
            pending.push(index);
    };
    let end = -1;
    while (pending.length > 0) {
        const index = pending.pop();
        if (index === undefined)
            continue;
        const instruction = code[index];
        const low = least[index];
        const high = most[index];
        if (instruction === undefined || low === undefined || high === undefined)
            continue;
        const opcode = instruction[0];
        if (opcode === 'HALT') {
            end = index;
            continue;
        }
        const nextLow = [...low];
        const nextHigh = [...high];
        if (opcode === 'EMIT') {
            const channel = instruction[1] ?? 0;
            nextLow[channel] = Math.min(cap, (nextLow[channel] ?? 0) + 1);
            nextHigh[channel] = Math.min(cap, (nextHigh[channel] ?? 0) + 1);
        }
        for (const position of targetPositions(opcode)) {
            const target = instruction[position + 1];
            if (typeof target === 'number')
                merge(target, nextLow, nextHigh);
        }
        if (opcode !== 'JUMP' && opcode !== 'RET')
            merge(index + 1, nextLow, nextHigh);
    }
    if (end < 0)
        return shape.fail('code', 'no path reaches HALT');
    const low = least[end] ?? [];
    const high = most[end] ?? [];
    for (let c = 0; c < channels; c += 1) {
        if (!once[c])
            continue;
        if (low[c] !== 1 || high[c] !== 1) {
            return shape.fail(`channels[${c}]`, `it is declared once and is written ${low[c] ?? 0} to ${high[c] ?? 0} times on a path to HALT`);
        }
    }
    return true;
}
//# sourceMappingURL=verify-code.js.map