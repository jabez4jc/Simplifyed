import { withoutGrouping } from '../ast/index.js';
import { libraryEntries } from '../check/index.js';
import { isInputCall, leavesValue } from './calls.js';
import { emitBindingRead, emitExpression } from './expressions.js';
import { emitDeclarationCall } from './outputs.js';
import { placementOf } from './registers.js';
const COMPOUND = {
    '+=': 'ADD',
    '-=': 'SUB',
    '*=': 'MUL',
    '/=': 'DIV',
    '%=': 'MOD',
};
export function emitBlock(e, f, block) {
    for (const statement of block.statements) {
        if (statement.kind === 'functionDeclaration')
            continue;
        emitStatement(e, f, statement);
    }
}
export function emitStatement(e, f, statement) {
    switch (statement.kind) {
        case 'versionLine':
        case 'scriptDeclaration':
        case 'limitsLine':
            // The header describes the file. It is `meta` and `limits`, read once.
            return;
        case 'expressionStatement': {
            // A declaration written as a statement of its own, `plot(close, "C")`
            // being the ordinary one, goes straight to the declaration path rather
            // than through the expression path that would reach the same function a
            // step later. The instructions are the same either way, and what it buys
            // is the invariant `outputs.ts` argues from: a declaration call reaches
            // `emitCall` only where a value is wanted.
            const declared = declarationIn(e, statement.expression);
            if (declared !== undefined) {
                emitDeclarationCall(e, f, declared.call, declared.name, undefined);
                return;
            }
            emitExpression(e, f, statement.expression);
            if (!leavesValue(e, statement.expression))
                return;
            f.builder.at(statement.span);
            f.builder.push('POP');
            return;
        }
        case 'assignment':
            emitAssignment(e, f, statement);
            return;
        case 'varDeclaration':
            emitVarDeclaration(e, f, statement);
            return;
        case 'ifStatement':
            emitIf(e, f, statement);
            return;
        case 'forRangeStatement':
            emitForRange(e, f, statement);
            return;
        case 'forInStatement':
            emitForIn(e, f, statement);
            return;
        case 'whileStatement':
            emitWhile(e, f, statement);
            return;
        case 'switchStatement':
            emitSwitch(e, f, statement);
            return;
        case 'breakStatement': {
            const loop = f.loops[f.loops.length - 1];
            f.builder.at(statement.span);
            const jump = f.builder.push('JUMP', 0);
            loop?.breaks.push(jump);
            return;
        }
        case 'continueStatement': {
            const loop = f.loops[f.loops.length - 1];
            f.builder.at(statement.span);
            const jump = f.builder.push('JUMP', 0);
            loop?.continues.push(jump);
            return;
        }
        case 'returnStatement': {
            f.builder.at(statement.span);
            // A bare return is `CONST 0` and `RET`, so every function returns a value
            // and `RET` never has to decide (4.10).
            if (statement.value === undefined)
                f.builder.push('CONST', e.pool.absent());
            else
                emitExpression(e, f, statement.value);
            f.builder.at(statement.span);
            f.builder.push('RET');
            return;
        }
    }
}
/** The resolved declaration call a statement is entirely one of, or nothing. */
function declarationIn(e, expression) {
    const inner = withoutGrouping(expression);
    if (inner.kind !== 'call')
        return undefined;
    const name = e.callAt(inner)?.name;
    return name !== undefined && e.isDeclaration(name) ? { call: inner, name } : undefined;
}
function emitStore(e, f, binding) {
    const placement = placementOf(e, binding);
    if (placement === 'cell')
        storeCell(e, f, binding);
    else if (placement === 'register')
        f.builder.push('SSTORE', e.layout.computedFor(binding));
    else
        f.builder.push('STORE', f.layout.slotFor(binding));
}
/**
 * A cell, and the register beside it when a function body reads the name.
 *
 * The register is written here as well as at the end of the bar, because a body
 * called between two assignments has to read the value the second one has not
 * written yet rather than the one the bar ended with.
 */
function storeCell(e, f, binding) {
    const register = e.carried.has(binding.id) ? e.layout.registerFor(binding) : undefined;
    if (register !== undefined)
        f.builder.push('DUP');
    f.builder.push('STOREC', f.layout.cellFor(binding));
    if (register !== undefined)
        f.builder.push('SSTORE', register);
}
function emitAssignment(e, f, statement) {
    const binding = e.checked.targets.get(statement.target);
    if (binding === undefined)
        return;
    // A declaration wearing an assignment's clothes: emit whatever the call does
    // per bar, which for an input and a grid is nothing, and store nothing. The
    // target is handed over because two declarations need it: a grid's handle
    // lives in the name's slot, and a plot's key is what `fill` later names.
    if (!leavesValue(e, statement.value)) {
        const inner = withoutGrouping(statement.value);
        if (inner.kind !== 'call')
            return;
        const name = e.callAt(inner)?.name ?? '';
        const key = emitDeclarationCall(e, f, inner, name, binding);
        if (key !== undefined)
            e.handleKeys.set(binding.id, key);
        return;
    }
    const compound = COMPOUND[statement.operator];
    if (compound !== undefined) {
        emitBindingRead(e, f, binding, statement.target.span);
        emitExpression(e, f, statement.value);
        f.builder.at(statement.span);
        f.builder.push(compound);
    }
    else {
        emitExpression(e, f, statement.value);
    }
    f.builder.at(statement.span);
    emitStore(e, f, binding);
}
/**
 * `var name = initial`, `compiled-program.md` 4.3.
 *
 * `CELL_INIT` marks the cell before the initialiser runs rather than after, so
 * the flag is set by one instruction rather than by a pair that has to stay
 * together across a jump.
 */
function emitVarDeclaration(e, f, statement) {
    const binding = e.checked.targets.get(statement.name);
    if (binding === undefined)
        return;
    // The same declaration wearing a declaration's own clothes: `var grid =
    // table(...)` declares a grid and keeps its handle, and a table is an
    // ordinary value a name may hold (`language.md` 5.4). The call leaves nothing
    // on the stack, so a cell to store into is a cell with nothing to put in it,
    // and the initialiser, the call and the store below would underflow.
    //
    // `input()` is the exception and it is the reason the second test is here.
    // Its row and its slot are declared before any statement is emitted, and what
    // is written where a value belongs is a read of that slot, so `var len =
    // input(14, "Length")` has a value to initialise the cell with and means what
    // every other `var` means. Without this it compiled to a cell nothing wrote
    // and a settings row a user could move that did nothing at all.
    if (!leavesValue(e, statement.initialiser) && !isInputCall(e, statement.initialiser)) {
        const inner = withoutGrouping(statement.initialiser);
        if (inner.kind !== 'call')
            return;
        const name = e.callAt(inner)?.name ?? '';
        const key = emitDeclarationCall(e, f, inner, name, binding);
        if (key !== undefined)
            e.handleKeys.set(binding.id, key);
        return;
    }
    const cell = f.layout.cellFor(binding);
    f.builder.at(statement.span);
    const init = f.builder.push('CELL_INIT', cell, 0);
    emitExpression(e, f, statement.initialiser);
    f.builder.at(statement.span);
    storeCell(e, f, binding);
    f.builder.patch(init, 1, f.builder.here);
}
function emitIf(e, f, statement) {
    const ends = [];
    statement.branches.forEach((branch, index) => {
        emitExpression(e, f, branch.condition);
        f.builder.at(branch.span);
        const next = f.builder.push('JUMP_FALSE', 0);
        emitBlock(e, f, branch.body);
        // A branch with nothing after it falls where its jump would have sent it,
        // which is why 12.2's worked example ends an `if` at its last instruction.
        const more = index + 1 < statement.branches.length || statement.elseBranch !== undefined;
        if (more) {
            f.builder.at(branch.span);
            ends.push(f.builder.push('JUMP', 0));
        }
        f.builder.patch(next, 0, f.builder.here);
    });
    if (statement.elseBranch !== undefined)
        emitBlock(e, f, statement.elseBranch.body);
    for (const end of ends)
        f.builder.patch(end, 0, f.builder.here);
}
function emitForRange(e, f, statement) {
    const binding = e.checked.targets.get(statement.variable);
    const variable = binding === undefined ? f.layout.slot('i') : f.layout.slotFor(binding);
    const limit = f.layout.slot('');
    const step = f.layout.slot('');
    const id = e.newLoop('for', statement.span);
    emitExpression(e, f, statement.from);
    emitExpression(e, f, statement.to);
    if (statement.step === undefined) {
        f.builder.at(statement.span);
        f.builder.push('CONST', e.pool.number(1));
    }
    else {
        emitExpression(e, f, statement.step);
    }
    f.builder.at(statement.span);
    const init = f.builder.push('FOR_INIT', id, variable, limit, step, 0);
    const tick = f.builder.here;
    f.builder.push('TICK', id);
    const frame = { id, breaks: [], continues: [] };
    f.loops.push(frame);
    emitBlock(e, f, statement.body);
    f.loops.pop();
    f.builder.at(statement.span);
    const next = f.builder.here;
    f.builder.push('FOR_NEXT', id, variable, limit, step, tick);
    const exit = f.builder.push('JUMP', 0);
    const after = f.builder.here;
    f.builder.patch(init, 4, after);
    f.builder.patch(exit, 0, after);
    for (const jump of frame.breaks)
        f.builder.patch(jump, 0, after);
    for (const jump of frame.continues)
        f.builder.patch(jump, 0, next);
}
/**
 * `for x in arr`, which has no instructions of its own (4.8).
 *
 * It compiles to a `while` over a hidden cursor, because its semantics already
 * are a `while`: the element count is read when the loop is entered, elements
 * appended during the loop are not visited, and the loop stops early if the
 * array shrinks past the cursor. The iterable is stored in a hidden slot first,
 * which 4.8's worked example does not show because its iterable is a bare name;
 * an expression evaluated three times would run its calls three times.
 */
function emitForIn(e, f, statement) {
    const binding = e.checked.targets.get(statement.variable);
    const variable = binding === undefined ? f.layout.slot('x') : f.layout.slotFor(binding);
    const source = f.layout.slot('');
    const limit = f.layout.slot('');
    const cursor = f.layout.slot('');
    const id = e.newLoop('forIn', statement.span);
    const size = libraryEntries('size').find((one) => one.callable);
    emitExpression(e, f, statement.iterable);
    f.builder.at(statement.span);
    f.builder.push('STORE', source);
    const sizeOf = () => {
        f.builder.push('LOAD', source);
        if (size === undefined) {
            e.gap('a `for x in` loop re-reads the array size each iteration and this file never calls ' +
                '`size`, so there is no entry of `lib.functions` for it to name', 'compiled-program.md 4.8 and 2.5', statement.span, true);
            f.builder.push('CONST', e.pool.absent());
            return;
        }
        f.builder.push('CALL_LIB', e.libraryFunction(size), 1, -1);
    };
    sizeOf();
    f.builder.push('STORE', limit);
    f.builder.push('CONST', e.pool.number(0));
    f.builder.push('STORE', cursor);
    const tick = f.builder.here;
    f.builder.push('TICK', id);
    f.builder.push('LOAD', cursor);
    f.builder.push('LOAD', limit);
    f.builder.push('LT');
    const done = f.builder.push('JUMP_FALSE', 0);
    f.builder.push('LOAD', cursor);
    sizeOf();
    f.builder.push('LT');
    const shrunk = f.builder.push('JUMP_FALSE', 0);
    f.builder.push('LOAD', source);
    f.builder.push('LOAD', cursor);
    f.builder.push('ELEM');
    f.builder.push('STORE', variable);
    const frame = { id, breaks: [], continues: [] };
    f.loops.push(frame);
    emitBlock(e, f, statement.body);
    f.loops.pop();
    f.builder.at(statement.span);
    const advance = f.builder.here;
    f.builder.push('LOAD', cursor);
    f.builder.push('CONST', e.pool.number(1));
    f.builder.push('ADD');
    f.builder.push('STORE', cursor);
    f.builder.push('JUMP', tick);
    const after = f.builder.here;
    f.builder.patch(done, 0, after);
    f.builder.patch(shrunk, 0, after);
    for (const jump of frame.breaks)
        f.builder.patch(jump, 0, after);
    for (const jump of frame.continues)
        f.builder.patch(jump, 0, advance);
}
function emitWhile(e, f, statement) {
    const id = e.newLoop('while', statement.span);
    f.builder.at(statement.span);
    const tick = f.builder.here;
    f.builder.push('TICK', id);
    emitExpression(e, f, statement.condition);
    f.builder.at(statement.span);
    const done = f.builder.push('JUMP_FALSE', 0);
    const frame = { id, breaks: [], continues: [] };
    f.loops.push(frame);
    emitBlock(e, f, statement.body);
    f.loops.pop();
    f.builder.at(statement.span);
    f.builder.push('JUMP', tick);
    const after = f.builder.here;
    f.builder.patch(done, 0, after);
    for (const jump of frame.breaks)
        f.builder.patch(jump, 0, after);
    for (const jump of frame.continues)
        f.builder.patch(jump, 0, tick);
}
/**
 * `switch`, in both forms of `language.md` 10.6.
 *
 * The arms do not fall through, so each one ends in a jump past the rest. With
 * a subject, the subject is evaluated once into a hidden slot and each case
 * value is compared against it; without one, each case value is a condition.
 */
function emitSwitch(e, f, statement) {
    let subject;
    if (statement.subject !== undefined) {
        subject = f.layout.slot('');
        emitExpression(e, f, statement.subject);
        f.builder.at(statement.span);
        f.builder.push('STORE', subject);
    }
    const ends = [];
    statement.cases.forEach((arm, armIndex) => {
        arm.values.forEach((value, index) => {
            if (subject === undefined) {
                emitExpression(e, f, value);
            }
            else {
                f.builder.at(value.span);
                f.builder.push('LOAD', subject);
                emitExpression(e, f, value);
                f.builder.at(value.span);
                f.builder.push('EQ');
            }
            if (index === 0)
                return;
            f.builder.at(value.span);
            f.builder.push('OR');
        });
        f.builder.at(arm.span);
        const next = f.builder.push('JUMP_FALSE', 0);
        emitBlock(e, f, arm.body);
        const more = armIndex + 1 < statement.cases.length || statement.defaultCase !== undefined;
        if (more) {
            f.builder.at(arm.span);
            ends.push(f.builder.push('JUMP', 0));
        }
        f.builder.patch(next, 0, f.builder.here);
    });
    if (statement.defaultCase !== undefined)
        emitBlock(e, f, statement.defaultCase.body);
    for (const end of ends)
        f.builder.patch(end, 0, f.builder.here);
}
//# sourceMappingURL=statements.js.map