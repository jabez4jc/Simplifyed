import { fieldValue } from '../engine/index.js';
/**
 * What one program's declaration says about money, after its inputs.
 *
 * The inputs are the ones the engine resolved at load, handed back by `load`
 * for this reader. A caller with none reads the literals, which is every
 * program that did not write a declaration field with an `input()`.
 */
export function declarationOf(program, inputs = []) {
    const strategy = program.meta.strategy;
    if (strategy === undefined) {
        return {
            isStrategy: false,
            capital: 0,
            currency: '',
            fillOn: '',
            slippage: 0,
            commission: 0,
            commissionType: '',
            qtyType: '',
        };
    }
    return {
        isStrategy: true,
        capital: numberOf(fieldValue(strategy.capital, inputs)),
        currency: stringOf(fieldValue(strategy.currency, inputs)),
        fillOn: stringOf(fieldValue(strategy.fillOn, inputs)),
        slippage: numberOf(fieldValue(strategy.slippage, inputs)),
        commission: numberOf(fieldValue(strategy.commission, inputs)),
        commissionType: stringOf(fieldValue(strategy.commissionType, inputs)),
        qtyType: stringOf(fieldValue(strategy.qtyType, inputs)),
    };
}
/**
 * A number the declaration states, or zero where it states something else.
 *
 * Zero rather than absence, and only here: every one of these fields is written
 * into the program with a number, so anything else is a program this engine
 * would already have refused at load. The fallback is what keeps this reader
 * total rather than a second place a malformed program is diagnosed.
 */
function numberOf(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
function stringOf(value) {
    return typeof value === 'string' ? value : '';
}
//# sourceMappingURL=declaration.js.map