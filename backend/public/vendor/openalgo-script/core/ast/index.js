/**
 * The syntax tree of language.md, and the one traversal over it.
 *
 * Types and constructors, and no parsing: the tree is what the parser produces
 * and what the checker, the code generator and the editor's intelligence all
 * read, so it is defined on its own and none of the four owns it.
 *
 * Two things here are worth knowing before reading the rest. Every node carries
 * a `Span`, so anything the compiler says about a node has a caret. And every
 * node is a member of one discriminated union, `AstNode`, so a pass that
 * switches on `kind` without a default arm is told at compile time about the
 * kinds it has not handled.
 */
export { OBJECT_TYPE_NAMES, VALUE_TYPE_NAMES, isObjectTypeName, isValueTypeName, } from './annotations.js';
export { ARITHMETIC_OPERATORS, COMPARISON_OPERATORS, EQUALITY_OPERATORS, LOGICAL_OPERATORS, UNARY_OPERATORS, binaryPrecedence, withoutGrouping, } from './expressions.js';
export { ASSIGNMENT_OPERATORS } from './statements.js';
export { isExpression, isStatement, isTypeAnnotation, typeAnnotationText } from './node.js';
export { makeNode } from './build.js';
export { childrenOf } from './children.js';
export { nodeAtOffset, pathAtOffset, walk } from './walk.js';
//# sourceMappingURL=index.js.map