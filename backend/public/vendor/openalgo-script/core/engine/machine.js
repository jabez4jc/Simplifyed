import { add, and, compare, divide, equals, isFalsey, multiply, negate, not, or, remainder, subtract, } from './arithmetic.js';
import { makeFrame, positionAt } from './frames.js';
import { constantValueOf, elementRead, forInit, forNext, historyRead, nameOf, } from './operations.js';
import { ABSENT, reference, storedValue } from './values/index.js';
/**
 * The region a stateless call is handed.
 *
 * Shared rather than allocated per call, because an entry declared without
 * state never touches it and an allocation on the path of every `max` and every
 * colour would be the engine's largest per bar cost for nothing.
 */
const NO_STATE = {};
export class Machine {
    parts;
    top;
    callers = [];
    frame;
    view;
    barIndex = 0;
    /** The loop whose `TICK` executed most recently, for OS5001's line. */
    lastLoop = -1;
    /**
     * The value a top level `RET` handed back, `compiled-program.md` 2.16.1.
     *
     * A program's own `code` ends in `HALT` and produces nothing, so this stays
     * absent for it. A request body ends in `RET` and its value is the read's
     * value for that requested bar, which is the one thing the interpreter has to
     * hand out rather than write into a register or a channel.
     */
    returned = ABSENT;
    ctx;
    ops;
    constructor(parts, view) {
        this.parts = parts;
        this.view = view;
        const { program } = parts;
        this.top = makeFrame(program.code, program.frame.slots, 0, 0, [], program.debug.pos);
        this.frame = this.top;
        this.ops = this.operations();
        // One context, reused by every call, with the two fields that change per
        // call read through getters. A fresh object per `CALL_LIB` would be an
        // allocation on the hottest path in the engine, and the span is a binary
        // search that most calls never ask for.
        const machine = this;
        this.ctx = {
            heap: parts.heap,
            host: parts.host,
            position: parts.position,
            guard: parts.guard,
            state: NO_STATE,
            get span() {
                return machine.here();
            },
            get bar() {
                return machine.view;
            },
            nameOf: (value) => machine.nameOf(value),
        };
    }
    /** Step 3: the stack, the slots and the frame stack all start empty. */
    begin(view, index) {
        this.view = view;
        this.barIndex = index;
        this.lastLoop = -1;
        this.returned = ABSENT;
        this.callers.length = 0;
        this.frame = this.top;
        this.top.pc = 0;
        this.top.stack.length = 0;
        this.top.slots.fill(ABSENT);
    }
    /** What the last `run` handed back, for an instruction list that ends in `RET`. */
    result() {
        return this.returned;
    }
    /** The slot array of frame 0, which inputs and grids are written into. */
    slots() {
        return this.top.slots;
    }
    /** Where the instruction that just executed came from. */
    here() {
        const at = positionAt(this.frame.positions, Math.max(this.frame.pc - 1, 0));
        return this.parts.spanAt(at.line, at.column);
    }
    /**
     * Runs the bar.
     *
     * The dispatch is a switch over the opcode name. A name rather than a number
     * is what the format carries (2.14) so that a program is readable and
     * diffable by hand; an engine may map names to its own integers at load and
     * must not depend on any numbering, because none is defined.
     */
    run() {
        const { budget, channels, memory, registers, heap } = this.parts;
        for (;;) {
            if (budget.step())
                budget.overrun(this.here(), this.loopLine());
            const frame = this.frame;
            const instruction = frame.code[frame.pc];
            frame.pc += 1;
            const stack = frame.stack;
            switch (instruction[0]) {
                case 'CONST':
                    stack.push(storedValue(constantValueOf(this.parts.program.consts[instruction[1]])));
                    break;
                case 'DUP':
                    stack.push(stack[stack.length - 1] ?? ABSENT);
                    break;
                case 'POP':
                    stack.pop();
                    break;
                case 'LOAD':
                    stack.push(frame.slots[instruction[1]] ?? ABSENT);
                    break;
                case 'STORE':
                    frame.slots[instruction[1]] = storedValue(pop(stack));
                    break;
                case 'CELL_INIT':
                    if (memory.initialise(frame.cellBase + instruction[1])) {
                        frame.pc = instruction[2];
                    }
                    break;
                case 'LOADC':
                    stack.push(memory.load(frame.cellBase + instruction[1]));
                    break;
                case 'STOREC':
                    memory.store(frame.cellBase + instruction[1], pop(stack));
                    break;
                case 'SLOAD':
                    stack.push(registers.get(instruction[1]));
                    break;
                case 'SSTORE':
                    registers.set(instruction[1], pop(stack));
                    break;
                case 'HIST':
                    stack.push(historyRead(this.ops, instruction[1], pop(stack)));
                    break;
                case 'HISTP':
                    stack.push(historyRead(this.ops, frame.series[instruction[1]] ?? -1, pop(stack)));
                    break;
                case 'ADD':
                    stack.push(this.joined(stack));
                    break;
                case 'SUB':
                    stack.push(binary(stack, subtract));
                    break;
                case 'MUL':
                    stack.push(binary(stack, multiply));
                    break;
                case 'DIV':
                    stack.push(binary(stack, divide));
                    break;
                case 'MOD':
                    stack.push(binary(stack, remainder));
                    break;
                case 'NEG':
                    stack.push(negate(pop(stack)));
                    break;
                case 'LT':
                case 'LE':
                case 'GT':
                case 'GE': {
                    const b = pop(stack);
                    stack.push(compare(instruction[0], pop(stack), b));
                    break;
                }
                case 'EQ': {
                    const b = pop(stack);
                    stack.push(equals(pop(stack), b));
                    break;
                }
                case 'NE': {
                    const b = pop(stack);
                    stack.push(!equals(pop(stack), b));
                    break;
                }
                case 'NOT':
                    stack.push(not(pop(stack)));
                    break;
                case 'AND':
                    stack.push(binary(stack, and));
                    break;
                case 'OR':
                    stack.push(binary(stack, or));
                    break;
                case 'AND_SHORT':
                    if (stack[stack.length - 1] === false)
                        frame.pc = instruction[1];
                    break;
                case 'OR_SHORT':
                    if (stack[stack.length - 1] === true)
                        frame.pc = instruction[1];
                    break;
                case 'JUMP':
                    frame.pc = instruction[1];
                    break;
                case 'JUMP_FALSE':
                    if (isFalsey(pop(stack)))
                        frame.pc = instruction[1];
                    break;
                case 'TICK': {
                    const loop = instruction[1];
                    this.lastLoop = loop;
                    budget.tick(this.here(), this.parts.program.loops[loop]?.line ?? 0);
                    break;
                }
                case 'FOR_INIT':
                    forInit(this.ops, instruction, frame);
                    break;
                case 'FOR_NEXT':
                    forNext(instruction, frame);
                    break;
                case 'ARRAY': {
                    const count = instruction[1];
                    const items = stack.splice(stack.length - count, count);
                    this.parts.guard.array(this.here(), 'the array', items.length);
                    stack.push(reference(heap.allocate({ kind: 'array', items })));
                    break;
                }
                case 'ELEM': {
                    const index = pop(stack);
                    stack.push(elementRead(this.ops, pop(stack), index));
                    break;
                }
                case 'CALL_LIB':
                    this.callLibrary(instruction, stack);
                    break;
                case 'CALL_FN':
                    this.callFunction(instruction[1], stack);
                    break;
                case 'RET': {
                    const value = pop(stack);
                    const caller = this.callers.pop();
                    if (caller === undefined) {
                        this.returned = value;
                        return;
                    }
                    this.frame = caller;
                    caller.stack.push(value);
                    break;
                }
                case 'EMIT':
                    channels.write(instruction[1], pop(stack));
                    break;
                case 'HALT':
                    return;
                default:
                    // Unreachable in a verified program: check 2 refused every opcode
                    // this switch does not have an arm for.
                    throw new Error(`${String(instruction[0])} is not an instruction`);
            }
        }
    }
    loopLine() {
        if (this.lastLoop < 0)
            return undefined;
        return this.parts.program.loops[this.lastLoop]?.line;
    }
    /** What the operations in `operations.ts` need, built once. */
    operations() {
        const machine = this;
        return {
            program: this.parts.program,
            registers: this.parts.registers,
            memory: this.parts.memory,
            heap: this.parts.heap,
            slots: this.top.slots,
            here: () => machine.here(),
            barIndex: () => machine.barIndex,
        };
    }
    /** `ADD` with the string ceiling applied, since it is the one that grows one. */
    joined(stack) {
        const b = pop(stack);
        const value = add(pop(stack), b);
        return typeof value === 'string' ? this.parts.guard.string(this.here(), value) : value;
    }
    /**
     * `CALL_LIB`.
     *
     * A call whose manifest entry carries an effect does not perform it: it
     * appends a record holding the function index and the argument values as they
     * stood, and pushes absent. The machine does that here rather than in the
     * entry, so an effect cannot be forgotten by whoever writes the next one.
     */
    callLibrary(instruction, stack) {
        const index = instruction[1];
        const count = instruction[2];
        const state = instruction[3];
        const args = stack.splice(stack.length - count, count);
        const of = this.parts.library[index];
        if (of.effect !== 'none') {
            this.parts.channels.defer({
                fn: index,
                name: of.name,
                effect: of.effect,
                args,
                params: of.params,
                at: this.here(),
            });
            stack.push(ABSENT);
            return;
        }
        this.ctx.state =
            state < 0 ? NO_STATE : this.parts.memory.region(this.frame.stateBase + state);
        stack.push(storedValue(of.call(this.ctx, args)));
    }
    /** `CALL_FN`: everything it needs is in the call site, 4.10. */
    callFunction(site, stack) {
        const { program, fnPositions } = this.parts;
        const call = program.callSites[site];
        if (call === undefined)
            return;
        const target = program.functions[call.fn];
        if (target === undefined)
            return;
        const args = stack.splice(stack.length - call.argc, call.argc);
        const frame = makeFrame(target.code, target.slots, call.cellBase, call.stateBase, call.series, fnPositions[call.fn] ?? []);
        for (let i = 0; i < args.length; i += 1)
            frame.slots[i] = storedValue(args[i] ?? ABSENT);
        this.callers.push(this.frame);
        this.frame = frame;
    }
    /** The name a value goes by, which a library call asks for by the same route. */
    nameOf(value) {
        return nameOf(this.ops, value);
    }
}
/** The stack cannot be empty here: the verifier's depth walk proved it. */
function pop(stack) {
    return stack.pop() ?? ABSENT;
}
function binary(stack, of) {
    const b = pop(stack);
    return of(pop(stack), b);
}
//# sourceMappingURL=machine.js.map