import { literalString } from './literals.js';
/**
 * The calls that append a ledger row a later `close` can act on.
 *
 * `exit`, `order.bracket` and `cancel` are not among them: a bracket is a level
 * and a cancellation is an instruction about an order, and neither appends a
 * row (`stdlib.md` 17.7). Nor is `close` itself, which only ever reduces what
 * one of these opened, so a close that is the only mention of a tag is exactly
 * the call this pass is about.
 */
const PLACING = new Set(['buy', 'sell', 'order.place', 'order.reverse']);
/** The `tag` argument a call was given, absent where it was not written. */
function tagArgument(checked) {
    const index = checked.entry?.parameters.findIndex((one) => one.name === 'tag') ?? -1;
    return index < 0 ? undefined : checked.arguments[index];
}
/** OS7016: a `close` naming a tag no order in this file is placed with. */
export function reportUnplaceableTags(checker) {
    if (checker.declaration?.form !== 'strategy')
        return;
    const placed = new Set();
    const closes = [];
    for (const checked of checker.calls) {
        if (checked.target !== 'library')
            continue;
        if (PLACING.has(checked.name)) {
            const argument = tagArgument(checked);
            // A call that writes no tag takes the empty one its signature states.
            if (argument === undefined) {
                placed.add('');
                continue;
            }
            const written = literalString(argument.value);
            if (written === undefined)
                return;
            placed.add(written);
            continue;
        }
        if (checked.name !== 'close')
            continue;
        const argument = tagArgument(checked);
        if (argument === undefined)
            continue;
        const written = literalString(argument.value);
        if (written !== undefined)
            closes.push({ tag: written, span: argument.span });
    }
    for (const close of closes) {
        if (placed.has(close.tag))
            continue;
        checker.report('OS7016', close.span, { tag: JSON.stringify(close.tag) });
    }
}
//# sourceMappingURL=tags.js.map