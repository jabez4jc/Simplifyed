/**
 * The compiled program emitter: the artifact this whole project exists to
 * produce.
 *
 * Everything else in `src/core` serves one compiler. This produces the thing
 * somebody else's engine reads, in Java, in Go or in Python, from
 * `spec/compiled-program.md` and nothing else. So the surface here is narrow on
 * purpose: a function that emits one, the types that describe one, and the
 * canonical encoding that makes a hash of one mean something.
 *
 * `COMPILED_FORMAT_VERSION` is generated from the specification and the release
 * refuses to publish if the compiler and the specification disagree, which is why
 * nothing here writes a version literal.
 */
export { emit } from './emit.js';
export { DECLARATION_CALLS, arityOf, effectOf } from './context.js';
export { declarationDefaultText } from './defaults.js';
export { namedColour } from './colours.js';
export { BAR_FACTS, BAR_FIELDS } from './registers.js';
export { REQUEST_CALLS, REQUEST_STATUS_CALLS } from './requests.js';
export { canonicalise, canonicalNumber, canonicalString, programHash, sourceHash } from './canonical.js';
export { sha256, utf8 } from './sha256.js';
export { OPCODES, depthChange, isOpcode, operandCount, targetPositions } from './opcodes.js';
export { walkDepths } from './code.js';
//# sourceMappingURL=index.js.map