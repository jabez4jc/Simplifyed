import { fieldValue } from './inputs.js';
import { Ledger } from './ledger/index.js';
/**
 * One field of the `strategy()` declaration, resolved the way every other
 * declaration field is: once, at load, against the inputs.
 *
 * The fallback is the documented default rather than a guess. A study has no
 * strategy declaration at all and never places an order, so the values it takes
 * here are never read.
 */
function declared(field, inputs) {
    return field === undefined ? null : fieldValue(field, inputs);
}
export function ledgerFor(program, inputs, instrument) {
    const strategy = program.meta.strategy;
    const product = declared(strategy?.product, inputs);
    const qtyType = declared(strategy?.qtyType, inputs);
    const qty = declared(strategy?.qty, inputs);
    const pyramiding = declared(strategy?.pyramiding, inputs);
    return new Ledger({
        // The file's only leg is the instrument its chart is showing (`stdlib.md`
        // 17.1), and its identity is the host's own, carried and never parsed. The
        // leg declarations that name any other contract are planned.
        instrument: { symbol: instrument?.symbol ?? null, exchange: instrument?.exchange ?? null },
        product: typeof product === 'string' ? product : 'intraday',
        qtyType: typeof qtyType === 'string' ? qtyType : 'units',
        declaredQty: typeof qty === 'number' ? qty : 1,
        // The instrument's own arithmetic, read from the record the host stated and
        // never guessed at: a tick size the host does not know is absent, and a
        // price is then refused against nothing rather than against a default.
        tickSize: typeof instrument?.tickSize === 'number' ? instrument.tickSize : null,
        pyramiding: typeof pyramiding === 'number' ? pyramiding : 1,
    });
}
/**
 * The effects a bar applied, mapped and then routed.
 *
 * An order call becomes intents here and nowhere else, because the ledger is
 * what mints the id every frame about the order carries back, and a call an
 * execution threw away never reached this step at all.
 *
 * **Mapping the whole bar and routing it are two passes, and that is what keeps
 * a refused order away from the destination.** A rule like OS7013 is about two
 * calls at once, so the second call is what refuses the pair, and a loop that
 * routed each call as it mapped it would already have sent the first. Every
 * call is therefore mapped before any of them is handed over, and a refusal
 * anywhere on the bar hands over none of them.
 *
 * **Which is why a refusal here discards the bar's rows.** Mapping a call
 * appends its row, because the calls after it on the same bar are measured
 * against the rows before them: a cancellation asks whether a tag is working, a
 * close asks what one tag entered, and pyramiding counts what a position
 * already holds. So the rows of a bar that is then refused have to be taken
 * back, or `engine.orders()` reports an order at `placed` that no destination
 * was ever handed, and a host reconciling after a stopped run sees an order it
 * never received. The bar's intents and the bar's rows cannot disagree, because
 * they are made and unmade together.
 */
export function routedEffects(ledger, applied, at, route) {
    // Where this pass found the ledger, so a refusal can take back exactly the
    // rows this pass appended and no others: a bar declared `onUnconfirmed`
    // routes on every execution of itself, and an earlier one really did hand its
    // orders over.
    const appended = ledger.rows().length;
    const effects = [];
    for (const effect of applied) {
        if (effect.effect !== 'order') {
            effects.push({ ...effect, intents: [] });
            continue;
        }
        const placed = ledger.place(effect.name, effect.params, effect.args, at, effect.at);
        if (placed.refusal !== undefined) {
            ledger.discard(appended);
            return { effects: [], refusal: placed.refusal };
        }
        effects.push({ ...effect, intents: placed.intents });
    }
    if (route !== undefined)
        for (const effect of effects)
            route(effect, at.index);
    return { effects, refusal: undefined };
}
//# sourceMappingURL=orders.js.map