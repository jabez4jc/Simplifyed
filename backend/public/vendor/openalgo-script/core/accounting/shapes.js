/**
 * The atoms the money is folded from: a fill, a contract and a bar's close.
 *
 * **Everything in this module is portable data.** No class, no function, no
 * object reference, no absent field, no map and no date: a shape here is what
 * `JSON.parse` gives back, so a report can be computed here, stored by a
 * platform, sent to another process and recomputed there without this
 * implementation being present. That is not a convenience. A run record is the
 * conformance case a second engine is handed, and a case that can only be read
 * by the engine that wrote it proves nothing about either.
 *
 * **A fill is the only thing money is folded from.** Not a position, not a
 * ledger row, not a running total the engine happened to be holding: the fills
 * the engine settled, in the order it settled them, each naming the position
 * reference it moved and the size of that reference either side of the
 * settlement. Every figure in a report is a function of that list and of the
 * bars it is marked against, which is what makes a report reproducible from a
 * record with no engine in the room.
 */
export {};
//# sourceMappingURL=shapes.js.map