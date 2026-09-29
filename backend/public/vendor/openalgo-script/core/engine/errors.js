import { diagnosticFor } from '../diagnostics/index.js';
import { makeSpan } from '../span/index.js';
/** A diagnostic on its way out of the machine. */
export class ScriptError extends Error {
    diagnostic;
    constructor(diagnostic) {
        super(diagnostic.code);
        this.name = 'ScriptError';
        this.diagnostic = diagnostic;
    }
}
/**
 * Where a diagnostic points.
 *
 * A compiled program carries a line and a column per instruction and not an
 * offset, because `debug.pos` is a position in the source rather than an index
 * into text the engine was never given. When a host hands the engine the source
 * file as well, the offset is worked out from the position and a renderer can
 * draw the caret under the line; without it the line and the column still say
 * where, which is what an error message needs.
 */
export function spanAt(source, line, column) {
    if (source === undefined)
        return makeSpan(0, 0, line, column);
    return makeSpan(source.offsetAt({ line, column }), 0, line, column);
}
/** The position a load-time failure carries: the program, not a line of source. */
export const NO_POSITION = makeSpan(0, 0, 0, 0);
export function raise(code, span, values) {
    throw new ScriptError(diagnosticFor(code, span, values));
}
export function failure(code, span, values) {
    return diagnosticFor(code, span, values);
}
/**
 * A verification failure, `compiled-program.md` 3.5.
 *
 * One code covers a malformed instruction list, an unreadable encoding and an
 * input reference naming an input that was never declared, because they are not
 * separate fixes: all three are defects of the compiler that wrote the program
 * and none of them is repairable by hand.
 */
export function malformed(location, reason) {
    return failure('OS6018', NO_POSITION, { location, reason });
}
/** The location half of OS6018 for an instruction, in the spelling 3.5 gives. */
export function atInstruction(list, index) {
    return list === 'code' ? `instruction ${index}` : `${list} instruction ${index}`;
}
/**
 * Whatever escaped that was not a diagnostic.
 *
 * A verified program cannot underflow the stack, jump out of bounds or address
 * a slot that does not exist, so an exception from inside the interpreter means
 * the program is not what verification said it was. It becomes a diagnostic on
 * this script rather than an exception in the host's render loop, which is the
 * whole of "one script failing takes nothing else down".
 */
export function unexpected(where, thrown) {
    const reason = thrown instanceof Error ? thrown.message : String(thrown);
    return malformed(where, `the engine could not execute it: ${reason}`);
}
//# sourceMappingURL=errors.js.map