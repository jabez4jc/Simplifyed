/**
 * Builds any node.
 *
 * One constructor rather than forty two, because forty two would be a second
 * place that has to agree with the interfaces, and the day one of them drifts
 * is the day a field goes missing from a tree that still type checks at every
 * call site. Here the fields are the interface, minus the two parts every node
 * has, so a missing field, a misspelt one and a stray one are each a compile
 * error at the parser's own line.
 *
 * It also reads as what it builds. `makeNode('binary', span, { operator, left,
 * right })` names its three parts, where a positional constructor of the same
 * arity would let a parser swap two of them and compile.
 *
 * No field is optional. A slot a script may leave out, such as a `step` or an
 * `else`, is `undefined` and still has to be passed, because a parser that
 * forgets one should hear about it rather than produce a node that is missing
 * a branch.
 */
export function makeNode(kind, span, fields) {
    // The spread of a generic Omit cannot be proved to reconstruct the node it
    // was taken from, so the one assertion in the module is here, where the
    // signature above has already checked every field of every call.
    return { ...fields, kind, span };
}
//# sourceMappingURL=build.js.map