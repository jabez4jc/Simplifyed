/**
 * The two shapes that cross the order boundary, `host-interface.md` 7.1 and
 * 7.2.
 *
 * **An intent is not an order.** The engine states what the strategy decided
 * and the destination makes the order, which is the whole reason the duty is
 * shaped as two messages rather than one call. An engine that named a
 * destination's own order id at the moment a script called `buy()` would be
 * handing the script an identifier for something that may never exist.
 *
 * **A frame is cumulative.** Every frame restates the whole life of one order
 * rather than what changed since the frame before it, which is what makes a
 * repeat, a pair that crossed in flight and a reconnecting session that resends
 * its last frames all harmless. The fold that depends on it is `row.ts`.
 *
 * Nothing here parses an identity. A resolved identity may be a string, a
 * number, a pair or a row in the host's own table (`host-interface.md` 9.1), so
 * the engine carries the one it was given and hands it back unchanged.
 */
export {};
//# sourceMappingURL=intent.js.map