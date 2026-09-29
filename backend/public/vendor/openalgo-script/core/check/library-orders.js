/**
 * The part of the library that spends money: `stdlib.md` section 17.
 *
 * Every entry here is marked `strategyOnly`, which is the whole of what the
 * checker has to know about the section's opening rule: a `study()` file that
 * reaches for one of these is OS7001, and the fix names the declaration to
 * change rather than the call to delete.
 *
 * A leg is named by a string rather than by a handle, so nothing in this file
 * carries a type the rest of the language does not already have.
 *
 * **What is marked `planned` here is what no engine can run yet**, and it is
 * marked rather than left to be discovered. The legs and the book of sections
 * 17.6 and 17.9 to 17.11 are rules evaluated over the ledger, and the money
 * figures need a cost model; neither exists in an engine in this release. A name
 * left unmarked would compile and then be refused at load with OS6004, which
 * names a function and not a reason. Marked, it is OS2020 at the call, at the
 * point a reader can see what they wrote, with a message that says it is
 * planned.
 *
 * The nine order functions and the five position facts are not marked, because
 * those do run: the ledger of section 17.7 is folded from the intents those nine
 * send and the frames a host reports back for them, and the five read it. None
 * of them reads a host's position row, and section 17.1 is why.
 */
import { DATA_DRIVEN, entry } from './library.js';
const SIDES = ['buy', 'sell'];
const ORDER_TYPES = ['market', 'limit', 'stop', 'stopLimit'];
const DIRECTIONS = ['up', 'down'];
const BOOK_DIRECTIONS = ['long', 'short', 'both'];
const LEG_KINDS = ['future', 'option'];
const RIGHTS = ['call', 'put'];
const strategyOnly = { strategyOnly: true };
/**
 * Every order function names the leg it acts on, and no file can declare one.
 *
 * A leg is declared before the run with `leg.fixed` or `leg.relative`
 * (`stdlib.md` 17.6), and both of those are planned below. So the set of names
 * a `leg` argument may take is empty in this release, and a file that declares
 * no leg has exactly one, which every order acts on with no leg named.
 *
 * Which makes the argument a refusal rather than a set check. The value never
 * comes into it: `close(leg = "b")` after `buy(leg = "a")` flattened the
 * position on the only leg there is, and a name the script computed was
 * ignored just as quietly. OS3023 says so at the call, whichever of the two it
 * is, and the day a leg can be declared this becomes the set check OS3008
 * already is for every other argument with a fixed set of values.
 */
const onOneLeg = { strategyOnly: true, undeclared: ['leg'] };
/** The bare order functions of stdlib.md 17.2, which `close` is one of. */
export const ORDER_NAMES = [
    'buy',
    'sell',
    'close',
    'exit',
    'cancel',
    'cancelAll',
];
const placing = [
    entry('buy(qty?: number, limit?: number = none, stop?: number = none, tag?: string = "", leg?: string) -> nothing', onOneLeg),
    entry('sell(qty?: number, limit?: number = none, stop?: number = none, tag?: string = "", leg?: string) -> nothing', onOneLeg),
    entry('close(tag?: string = none, qty?: number = none, leg?: string) -> nothing', onOneLeg),
    entry('exit(tag?: string = "", qty?: number = none, limit?: number = none, stop?: number = none, profit?: number = none, loss?: number = none, leg?: string) -> nothing', {
        ...onOneLeg,
        // An absolute price and a distance from the entry state the same level,
        // and reconciling them would need a rule (stdlib.md 17.2).
        conflicts: [
            ['limit', 'profit'],
            ['stop', 'loss'],
        ],
    }),
    entry('cancel(tag: string) -> nothing', strategyOnly),
    entry('cancelAll() -> nothing', strategyOnly),
];
const orders = [
    entry('order.place(side: string, qty: number, type?: string = "market", price?: number = none, trigger?: number = none, tag?: string = "", leg?: string) -> nothing', { ...onOneLeg, values: { side: SIDES, type: ORDER_TYPES } }),
    entry('order.reverse(qty?: number = none, tag?: string = "", leg?: string) -> nothing', onOneLeg),
    entry('order.bracket(tag?: string = "", profit?: number = none, loss?: number = none, leg?: string) -> nothing', onOneLeg),
    entry('order.working(tag: string) -> series bool', { ...strategyOnly, planned: true }),
    entry('order.pending -> series number', { ...strategyOnly, planned: true }),
    entry('order.id(tag: string) -> series string', { ...strategyOnly, planned: true }),
    entry('order.status(tag: string) -> series string', { ...strategyOnly, planned: true }),
    entry('order.filled(tag: string) -> series number', { ...strategyOnly, planned: true }),
    entry('order.avgFill(tag: string) -> series number', {
        ...strategyOnly,
        planned: true,
        warmup: DATA_DRIVEN,
    }),
    entry('order.rejection(tag: string) -> series string', { ...strategyOnly, planned: true }),
    entry('order.qtyForCash(cash: number, price?: number = close) -> number', {
        ...strategyOnly,
        planned: true,
    }),
    entry('order.qtyForRisk(risk: number, entry: number, stop: number) -> number', {
        ...strategyOnly,
        planned: true,
    }),
    entry('order.qtyForEquityPercent(percent: number, price?: number = close) -> number', {
        ...strategyOnly,
        planned: true,
    }),
    entry('order.roundToLot(qty: number, direction?: string = "down", leg?: string) -> number', {
        ...strategyOnly,
        planned: true,
        values: { direction: DIRECTIONS },
    }),
    entry('order.modify(tag: string) -> nothing', { ...strategyOnly, planned: true }),
    entry('order.oco(tagA: string, tagB: string) -> nothing', { ...strategyOnly, planned: true }),
];
const position = [
    entry('pos.size -> series number', strategyOnly),
    entry('pos.isLong -> series bool', strategyOnly),
    entry('pos.isShort -> series bool', strategyOnly),
    entry('pos.isFlat -> series bool', strategyOnly),
    entry('pos.avgPrice -> series number', { ...strategyOnly, warmup: DATA_DRIVEN }),
    entry('pos.entryTime -> series number', {
        ...strategyOnly,
        planned: true,
        warmup: DATA_DRIVEN,
    }),
    entry('pos.barsHeld -> series number', {
        ...strategyOnly,
        planned: true,
        warmup: DATA_DRIVEN,
    }),
    entry('pos.entries -> series number', { ...strategyOnly, planned: true }),
    entry('pos.openProfit -> series number', {
        ...strategyOnly,
        planned: true,
        warmup: DATA_DRIVEN,
    }),
    entry('pos.openProfitPercent -> series number', {
        ...strategyOnly,
        planned: true,
        warmup: DATA_DRIVEN,
    }),
    entry('pos.maxProfit -> series number', {
        ...strategyOnly,
        planned: true,
        warmup: DATA_DRIVEN,
    }),
    entry('pos.maxLoss -> series number', {
        ...strategyOnly,
        planned: true,
        warmup: DATA_DRIVEN,
    }),
    entry('pos.isShared -> series bool', { ...strategyOnly, planned: true }),
    entry('pos.equity -> series number', { ...strategyOnly, planned: true }),
    entry('pos.netProfit -> series number', { ...strategyOnly, planned: true }),
    entry('pos.tradeCount -> series number', { ...strategyOnly, planned: true }),
    entry('pos.winRate -> series number', { ...strategyOnly, planned: true }),
    entry('pos.profitFactor -> series number', { ...strategyOnly, planned: true }),
    entry('pos.maxDrawdown -> series number', { ...strategyOnly, planned: true }),
];
const legs = [
    entry('leg.fixed(name: string, symbol: string, exchange?: string = chart.exchange, product?: string, qty?: number, side?: string = "buy") -> nothing', {
        ...strategyOnly,
        planned: true,
        topLevel: true,
        values: { side: SIDES },
        constant: ['name', 'symbol', 'exchange', 'product', 'qty', 'side'],
    }),
    entry('leg.relative(name: string, underlying: string, kind: string, expiryRank?: number = 0, expiryCycle?: string = none, strikeOffset?: number = 0, right?: string = none, reference?: number = none, exchange?: string = chart.exchange, product?: string, qty?: number, side?: string = "buy") -> nothing', {
        ...strategyOnly,
        planned: true,
        topLevel: true,
        values: { kind: LEG_KINDS, right: RIGHTS, side: SIDES },
        constant: [
            'name',
            'underlying',
            'kind',
            'expiryRank',
            'expiryCycle',
            'strikeOffset',
            'right',
            'reference',
            'exchange',
            'product',
            'qty',
            'side',
        ],
    }),
    entry('leg.symbol(name: string) -> string', { ...strategyOnly, planned: true }),
    entry('leg.exchange(name: string) -> string', { ...strategyOnly, planned: true }),
    entry('leg.product(name: string) -> string', { ...strategyOnly, planned: true }),
    entry('leg.expiry(name: string) -> number', { ...strategyOnly, planned: true }),
    entry('leg.strike(name: string) -> number', { ...strategyOnly, planned: true }),
    entry('leg.size(name: string) -> series number', { ...strategyOnly, planned: true }),
    entry('leg.avgPrice(name: string) -> series number', {
        ...strategyOnly,
        planned: true,
        warmup: DATA_DRIVEN,
    }),
    entry('leg.entryTime(name: string) -> series number', {
        ...strategyOnly,
        planned: true,
        warmup: DATA_DRIVEN,
    }),
    entry('leg.profit(name: string) -> series number', { ...strategyOnly, planned: true }),
    entry('leg.isOpen(name: string) -> series bool', { ...strategyOnly, planned: true }),
    entry('leg.stopPrice(name: string) -> series number', {
        ...strategyOnly,
        planned: true,
        warmup: DATA_DRIVEN,
    }),
    entry('leg.targetPrice(name: string) -> series number', {
        ...strategyOnly,
        planned: true,
        warmup: DATA_DRIVEN,
    }),
    entry('leg.stop(name: string, price: number) -> nothing', { ...strategyOnly, planned: true }),
    entry('leg.target(name: string, price: number) -> nothing', { ...strategyOnly, planned: true }),
    entry('leg.trail(name: string, distance: number, activateAt?: number = none) -> nothing', {
        ...strategyOnly,
        planned: true,
    }),
    entry('leg.enter(name: string, side?: string, qty?: number, limit?: number = none, stop?: number = none, tag?: string = "") -> nothing', { ...strategyOnly, planned: true, values: { side: SIDES } }),
    entry('leg.exit(name: string, qty?: number = none, limit?: number = none, stop?: number = none, tag?: string = "") -> nothing', { ...strategyOnly, planned: true }),
];
const book = [
    entry('book.stop(amount: number) -> nothing', { ...strategyOnly, planned: true }),
    entry('book.target(amount: number) -> nothing', { ...strategyOnly, planned: true }),
    entry('book.lockProfit(activateAt: number, lock: number, step?: number = none, advance?: number = none) -> nothing', { ...strategyOnly, planned: true }),
    entry('book.trailStopsToEntry(at: number) -> nothing', { ...strategyOnly, planned: true }),
    entry('book.direction(filter: string) -> nothing', {
        ...strategyOnly,
        planned: true,
        values: { filter: BOOK_DIRECTIONS },
    }),
    entry('book.entryWindow(spec: string) -> nothing', { ...strategyOnly, planned: true }),
    entry('book.exitAt(time: string) -> nothing', { ...strategyOnly, planned: true }),
    entry('book.squareOffAtExpiry(minutesBefore?: number = 0) -> nothing', {
        ...strategyOnly,
        planned: true,
    }),
    entry('book.dailyLoss(amount: number) -> nothing', { ...strategyOnly, planned: true }),
    entry('book.profit -> series number', { ...strategyOnly, planned: true }),
    entry('book.dayProfit -> series number', { ...strategyOnly, planned: true }),
    entry('book.isOpen -> series bool', { ...strategyOnly, planned: true }),
    entry('book.enter(tag?: string = "") -> nothing', { ...strategyOnly, planned: true }),
    entry('book.exit(tag?: string = "") -> nothing', { ...strategyOnly, planned: true }),
];
export const ORDER_ENTRIES = [
    ...placing,
    ...orders,
    ...position,
    ...legs,
    ...book,
];
//# sourceMappingURL=library-orders.js.map