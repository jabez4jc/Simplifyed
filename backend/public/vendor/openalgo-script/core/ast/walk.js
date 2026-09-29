import { containsOffset } from '../span/index.js';
import { childrenOf } from './children.js';
/**
 * Every node, depth first, parents before children and children in source
 * order.
 *
 * `leave` runs for a node whose children were skipped, so a pass that opens
 * something on the way in and closes it on the way out stays balanced whatever
 * it skips. A scope left open by a skipped node is the kind of fault that shows
 * up as a name resolving in the wrong place, three files away from its cause.
 *
 * A pass that has to handle every kind should not use this. It should switch on
 * `node.kind` with no default arm, so that the compiler names the kinds it has
 * missed; this is for a pass that cares about a few kinds and wants the rest
 * walked for it.
 */
export function walk(root, visitor) {
    visitNode(root, undefined, visitor);
}
function visitNode(node, parent, visitor) {
    if (visitor.enter?.(node, parent) !== 'skip') {
        for (const child of childrenOf(node))
            visitNode(child, node, visitor);
    }
    visitor.leave?.(node, parent);
}
/**
 * The nodes covering an offset, outermost first, ending at the smallest one.
 *
 * This is what an editor asks for and it is one function rather than three,
 * because hover, completion and signature help each need the node under the
 * caret and the ancestors above it, and three copies of a descent through the
 * tree would answer differently at a boundary.
 *
 * A span covers its first character and stops before the one after it, and a
 * span of no length covers nothing, so a caret sitting between two characters
 * is inside the one on its left: an editor asking about a caret asks about the
 * offset before it.
 */
export function pathAtOffset(root, offset) {
    const path = [];
    let current = containsOffset(root.span, offset) ? root : undefined;
    while (current !== undefined) {
        path.push(current);
        current = childrenOf(current).find((child) => containsOffset(child.span, offset));
    }
    return path;
}
/** The smallest node covering an offset, or nothing when the offset is outside. */
export function nodeAtOffset(root, offset) {
    const path = pathAtOffset(root, offset);
    return path[path.length - 1];
}
//# sourceMappingURL=walk.js.map