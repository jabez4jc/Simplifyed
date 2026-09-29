import { depthChange, operandCount, targetPositions } from './opcodes.js';
export class CodeBuilder {
    instructions = [];
    positions = [];
    line = 0;
    column = 0;
    /** Where the instructions pushed after this call came from. */
    at(span) {
        this.line = span.line;
        this.column = span.column;
    }
    /** The index the next instruction will take, which is what a jump targets. */
    get here() {
        return this.instructions.length;
    }
    /**
     * Appends one instruction and returns its index.
     *
     * The operand count is checked here because an instruction with the wrong
     * number of operands is a program an engine refuses at load with one code and
     * no line (3.5 check 2), and this is the last place that still knows the line.
     */
    push(opcode, ...operands) {
        if (operands.length !== operandCount(opcode)) {
            throw new Error(`${opcode} takes ${operandCount(opcode)} operands and was given ${operands.length}`);
        }
        const index = this.instructions.length;
        const last = this.positions[this.positions.length - 1];
        if (last === undefined || last[1] !== this.line || last[2] !== this.column) {
            this.positions.push([index, this.line, this.column]);
        }
        this.instructions.push([opcode, ...operands]);
        return index;
    }
    /** Fills in a jump whose target was not known when it was emitted. */
    patch(index, operand, target) {
        const instruction = this.instructions[index];
        if (instruction === undefined)
            throw new Error(`no instruction at ${index}`);
        const operands = instruction.slice(1);
        operands[operand] = target;
        this.instructions[index] = [instruction[0], ...operands];
    }
    get code() {
        return this.instructions;
    }
    get pos() {
        return this.positions;
    }
}
/**
 * The stack depth at every instruction, computed exactly as section 3.5 does.
 *
 * A forward pass is enough because every backward jump in a program this
 * compiler emits targets a `TICK` at a loop header, and a loop body leaves the
 * stack as it found it. The walk still records a disagreement rather than
 * assuming one, so a bug in a pass shows up here and not in an engine.
 */
export function walkDepths(code, argcOf) {
    const depths = new Array(code.length).fill(undefined);
    let conflict;
    let underflow;
    let terminal;
    const reach = (index, depth) => {
        if (index < 0 || index > code.length)
            return;
        if (depth < 0 && underflow === undefined)
            underflow = index;
        const known = depths[index];
        if (known === undefined)
            depths[index] = depth;
        else if (known !== depth && conflict === undefined)
            conflict = index;
    };
    reach(0, 0);
    for (let i = 0; i < code.length; i += 1) {
        const instruction = code[i];
        const depth = depths[i];
        if (instruction === undefined || depth === undefined)
            continue;
        const opcode = instruction[0];
        const operands = instruction.slice(1);
        const after = depth + depthChange(opcode, operands, argcOf);
        if (opcode === 'RET' || opcode === 'HALT') {
            if (after !== 0 && terminal === undefined)
                terminal = i;
            continue;
        }
        for (const position of targetPositions(opcode)) {
            const target = operands[position];
            if (target !== undefined)
                reach(target, after);
        }
        if (opcode !== 'JUMP')
            reach(i + 1, after);
    }
    return {
        depths: depths.map((one) => one ?? 0),
        conflict,
        underflow,
        terminal,
    };
}
//# sourceMappingURL=code.js.map