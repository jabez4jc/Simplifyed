/** The two sides, `stdlib.md` 17.2. */
const SIDES = ['buy', 'sell'];
/** The four types, `stdlib.md` 17.2. */
const TYPES = ['market', 'limit', 'stop', 'stopLimit'];
/** The fields every call states, so each case below states only its own. */
const NOTHING = {
    absent: [],
    side: null,
    qty: null,
    type: null,
    limit: null,
    trigger: null,
    target: null,
    stop: null,
    profit: null,
    loss: null,
    tag: null,
};
/** A number the script stated, or nothing where it stated none. */
function number(args, index) {
    const value = args[index];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function text(args, index) {
    const value = args[index];
    return typeof value === 'string' ? value : null;
}
/**
 * Whether this argument holds no value.
 *
 * Absence and nothing at the position are the same answer, because a program
 * that supplied fewer arguments than the signature declares would have been
 * refused at load (`compiled-program.md` 2.5) and cannot reach here.
 */
function missing(args, index) {
    const value = args[index];
    return value === null || value === undefined;
}
/**
 * The arguments the script wrote that came out absent, in signature order.
 *
 * The last argument of an order call is the names of the arguments the script
 * wrote, so this is the whole of telling a default apart from a value nobody
 * computed. It reads the names rather than a list of its own, because the
 * signature is the manifest's and a second copy of it here is one more thing to
 * correct when a signature changes.
 */
function absentOf(params, args) {
    const last = params.length - 1;
    if (last < 0)
        return [];
    const value = args[last];
    const written = new Set(typeof value === 'string' ? value.split(' ') : []);
    const found = [];
    for (let i = 0; i < last; i += 1) {
        const name = params[i];
        if (name !== undefined && written.has(name) && missing(args, i))
            found.push(name);
    }
    return found;
}
/** A word that is one of a set, or nothing where it is not. */
function oneOf(set, word) {
    return set.find((one) => one === word) ?? null;
}
/** `buy` and `sell`, whose name is their side. */
function placing(side, args, at) {
    return {
        ...NOTHING,
        name: side,
        at,
        side,
        qty: number(args, 0),
        limit: number(args, 1),
        trigger: number(args, 2),
        tag: text(args, 3),
    };
}
/** Reads one call, whichever of the nine it is. */
export function callOf(name, params, args, at) {
    const absent = absentOf(params, args);
    const read = readCall(name, args, at);
    return absent.length === 0 ? read : { ...read, absent };
}
function readCall(name, args, at) {
    switch (name) {
        case 'buy':
            return placing('buy', args, at);
        case 'sell':
            return placing('sell', args, at);
        case 'close':
            // tag, qty. The tag defaults to absence rather than to the empty string,
            // because a call that names none flattens the whole leg and the empty
            // string is a tag an order can carry.
            return { ...NOTHING, name, at, qty: number(args, 1), tag: text(args, 0) };
        case 'exit':
            // tag, qty, limit, stop, profit, loss. An absolute price and a distance
            // for the same side cannot both be given, which the checker refuses at
            // the call with OS3010.
            return {
                ...NOTHING,
                name,
                at,
                qty: number(args, 1),
                target: number(args, 2),
                stop: number(args, 3),
                profit: number(args, 4),
                loss: number(args, 5),
                tag: text(args, 0),
            };
        case 'cancel':
            return { ...NOTHING, name, at, tag: text(args, 0) };
        case 'order.place': {
            // side, qty, type, price, trigger, tag.
            return {
                ...NOTHING,
                name,
                at,
                side: oneOf(SIDES, text(args, 0)),
                qty: number(args, 1),
                type: oneOf(TYPES, text(args, 2)),
                limit: number(args, 3),
                trigger: number(args, 4),
                tag: text(args, 5),
            };
        }
        case 'order.reverse':
            return { ...NOTHING, name, at, qty: number(args, 0), tag: text(args, 1) };
        case 'order.bracket':
            // tag, profit, loss: distances only, which is the whole of this spelling.
            return { ...NOTHING, name, at, profit: number(args, 1), loss: number(args, 2), tag: text(args, 0) };
        default:
            return { ...NOTHING, name, at };
    }
}
//# sourceMappingURL=call.js.map