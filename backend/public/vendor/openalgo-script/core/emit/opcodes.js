/**
 * The forty-one instructions of `compiled-program.md` section 4, and the two
 * facts an emitter has to get right about each one.
 *
 * The operand count is here so that a mistyped instruction is caught where it
 * is built rather than by an engine's verifier three systems away. The depth
 * change is here because section 3.5 check 5 requires the stack depth to be
 * computable by walking the list, to agree at every join and to be zero at
 * `HALT`; a compiler that cannot compute it cannot know it emitted a program
 * any engine will load, and this is the table that makes it computable.
 *
 * `ARRAY`, `CALL_LIB` and `CALL_FN` have a depth that depends on an operand, so
 * their entries carry the rule rather than a number.
 */
export const OPCODES = [
    'CONST',
    'DUP',
    'POP',
    'LOAD',
    'STORE',
    'CELL_INIT',
    'LOADC',
    'STOREC',
    'SLOAD',
    'SSTORE',
    'HIST',
    'HISTP',
    'ADD',
    'SUB',
    'MUL',
    'DIV',
    'MOD',
    'NEG',
    'LT',
    'LE',
    'GT',
    'GE',
    'EQ',
    'NE',
    'NOT',
    'AND',
    'OR',
    'AND_SHORT',
    'OR_SHORT',
    'JUMP',
    'JUMP_FALSE',
    'TICK',
    'FOR_INIT',
    'FOR_NEXT',
    'ARRAY',
    'ELEM',
    'CALL_LIB',
    'CALL_FN',
    'RET',
    'EMIT',
    'HALT',
];
const SHAPES = {
    CONST: { operands: 1, depth: 1 },
    DUP: { operands: 0, depth: 1 },
    POP: { operands: 0, depth: -1 },
    LOAD: { operands: 1, depth: 1 },
    STORE: { operands: 1, depth: -1 },
    CELL_INIT: { operands: 2, depth: 0 },
    LOADC: { operands: 1, depth: 1 },
    STOREC: { operands: 1, depth: -1 },
    SLOAD: { operands: 1, depth: 1 },
    SSTORE: { operands: 1, depth: -1 },
    HIST: { operands: 1, depth: 0 },
    HISTP: { operands: 1, depth: 0 },
    ADD: { operands: 0, depth: -1 },
    SUB: { operands: 0, depth: -1 },
    MUL: { operands: 0, depth: -1 },
    DIV: { operands: 0, depth: -1 },
    MOD: { operands: 0, depth: -1 },
    NEG: { operands: 0, depth: 0 },
    LT: { operands: 0, depth: -1 },
    LE: { operands: 0, depth: -1 },
    GT: { operands: 0, depth: -1 },
    GE: { operands: 0, depth: -1 },
    EQ: { operands: 0, depth: -1 },
    NE: { operands: 0, depth: -1 },
    NOT: { operands: 0, depth: 0 },
    AND: { operands: 0, depth: -1 },
    OR: { operands: 0, depth: -1 },
    AND_SHORT: { operands: 1, depth: 0 },
    OR_SHORT: { operands: 1, depth: 0 },
    JUMP: { operands: 1, depth: 0 },
    JUMP_FALSE: { operands: 1, depth: -1 },
    TICK: { operands: 1, depth: 0 },
    FOR_INIT: { operands: 5, depth: -3 },
    FOR_NEXT: { operands: 5, depth: 0 },
    ARRAY: { operands: 1, depth: 'arrayCount' },
    ELEM: { operands: 0, depth: -1 },
    CALL_LIB: { operands: 3, depth: 'callCount' },
    CALL_FN: { operands: 1, depth: 'callSite' },
    RET: { operands: 0, depth: -1 },
    EMIT: { operands: 1, depth: -1 },
    HALT: { operands: 0, depth: 0 },
};
export function operandCount(opcode) {
    return SHAPES[opcode].operands;
}
/**
 * The stack depth change of one instruction.
 *
 * `argcOf` answers for a `CALL_FN`, because its count lives in the call site
 * table rather than in the instruction, and the walker is the only caller that
 * has that table in hand.
 */
export function depthChange(opcode, operands, argcOf) {
    const shape = SHAPES[opcode];
    if (shape.depth === 'arrayCount')
        return 1 - (operands[0] ?? 0);
    if (shape.depth === 'callCount')
        return 1 - (operands[1] ?? 0);
    if (shape.depth === 'callSite')
        return 1 - argcOf(operands[0] ?? 0);
    return shape.depth;
}
/** The operand positions that hold a jump target, for the verifier's check 3. */
const TARGETS = {
    CELL_INIT: [1],
    AND_SHORT: [0],
    OR_SHORT: [0],
    JUMP: [0],
    JUMP_FALSE: [0],
    FOR_INIT: [4],
    FOR_NEXT: [4],
};
export function targetPositions(opcode) {
    return TARGETS[opcode] ?? [];
}
export function isOpcode(name) {
    return OPCODES.includes(name);
}
//# sourceMappingURL=opcodes.js.map