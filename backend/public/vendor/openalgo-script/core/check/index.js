/**
 * The checker: a syntax tree in, and the answer to two questions out.
 *
 * Is this a program the engine can run, and what does every name in it mean.
 * Those are one pass rather than two, because the second question is how the
 * first one is answered: a name resolves or it does not, an expression has a
 * type or the operator above it cannot be checked, and a value has a first bar
 * or a line would be drawn before there was anything to draw.
 *
 * What comes out is a `CheckedScript`. It is not a second tree: the syntax tree
 * is still the tree, and every answer is recorded against the node it is about,
 * so the code generator walks what the parser produced and looks the answers up
 * rather than working any of them out a second time.
 *
 * Nothing here throws. A file with three mistakes in it produces three
 * diagnostics and a checked tree with `unknown` where the mistakes were,
 * because a trader fixing three mistakes should see three of them.
 */
export { check } from './check.js';
export { inputHeldBy } from './checked.js';
export { alertKey } from './outputs.js';
export { FOLDABLE_CALLS } from './constant.js';
export { HANDLE_KINDS, OBJECT_KINDS, VALUE_KINDS, accepts, arrayOf, elementOf, isSeries, join, sameType, seriesOf, typeText, } from './types.js';
export { BAR_ZERO, allOf, atBar, atLeastBar, delayed, earlier, isNever, later } from './warmup.js';
export { NAMESPACES, REQUEST_NAMES, STRATEGY_NAMESPACES, describedNames, isLibraryName, isNamespace, libraryEntries, libraryNames, membersOf, proseFor, } from './surface.js';
//# sourceMappingURL=index.js.map