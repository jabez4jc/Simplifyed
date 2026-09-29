import { avgSkipStep, barsSinceStep, changeStep, correlationStep, countPresentStep, countStep, covarianceStep, crossStep, cumStep, emaStep, extremeStep, hmaStep, historyStep, percentRankStep, percentileStep, pivotStep, rmaStep, rocStep, runStep, smaStep, sumSkipStep, sumStep, valueWhenStep, wmaStep, } from '../../stdlib/index.js';
import { boolAt, lengthAt, numberAt } from './binding.js';
import { stateful } from './state.js';
/** The three crossing tests, which differ only in which direction counts. */
function crossing(name, direction) {
    return stateful(name, 'a b', (ctx, args) => crossStep(ctx.state, '', { a: numberAt(args, 0), b: numberAt(args, 1) }, direction));
}
export const SERIES_ENTRIES = [
    stateful('sma', 'src len', (ctx, args) => smaStep(ctx.state, 'q', numberAt(args, 0), lengthAt(ctx, 'sma', 'len', args, 1))),
    stateful('ema', 'src len', (ctx, args) => emaStep(ctx.state, 'e', numberAt(args, 0), lengthAt(ctx, 'ema', 'len', args, 1))),
    stateful('rma', 'src len', (ctx, args) => rmaStep(ctx.state, 'r', numberAt(args, 0), lengthAt(ctx, 'rma', 'len', args, 1))),
    stateful('wma', 'src len', (ctx, args) => wmaStep(ctx.state, 'w', numberAt(args, 0), lengthAt(ctx, 'wma', 'len', args, 1))),
    stateful('hma', 'src len', (ctx, args) => hmaStep(ctx.state, '', numberAt(args, 0), lengthAt(ctx, 'hma', 'len', args, 1))),
    stateful('highest', 'src len', (ctx, args) => extremeStep(ctx.state, 'q', numberAt(args, 0), lengthAt(ctx, 'highest', 'len', args, 1), true, false)),
    stateful('lowest', 'src len', (ctx, args) => extremeStep(ctx.state, 'q', numberAt(args, 0), lengthAt(ctx, 'lowest', 'len', args, 1), false, false)),
    stateful('highestBars', 'src len', (ctx, args) => extremeStep(ctx.state, 'q', numberAt(args, 0), lengthAt(ctx, 'highestBars', 'len', args, 1), true, true)),
    stateful('lowestBars', 'src len', (ctx, args) => extremeStep(ctx.state, 'q', numberAt(args, 0), lengthAt(ctx, 'lowestBars', 'len', args, 1), false, true)),
    stateful('change', 'src', (ctx, args) => changeStep(ctx.state, 'c', numberAt(args, 0), 1)),
    stateful('change', 'src len', (ctx, args) => changeStep(ctx.state, 'c', numberAt(args, 0), lengthAt(ctx, 'change', 'len', args, 1))),
    stateful('mom', 'src len', (ctx, args) => changeStep(ctx.state, 'c', numberAt(args, 0), lengthAt(ctx, 'mom', 'len', args, 1))),
    stateful('roc', 'src len', (ctx, args) => rocStep(ctx.state, '', numberAt(args, 0), lengthAt(ctx, 'roc', 'len', args, 1))),
    stateful('history', 'src n', (ctx, args) => historyStep(ctx.state, 'h', numberAt(args, 0), lengthAt(ctx, 'history', 'n', args, 1))),
    stateful('sum', 'src len', (ctx, args) => sumStep(ctx.state, 'q', numberAt(args, 0), lengthAt(ctx, 'sum', 'len', args, 1))),
    stateful('sumSkip', 'src len', (ctx, args) => sumSkipStep(ctx.state, 'q', numberAt(args, 0), lengthAt(ctx, 'sumSkip', 'len', args, 1))),
    stateful('avgSkip', 'src len', (ctx, args) => avgSkipStep(ctx.state, 'q', numberAt(args, 0), lengthAt(ctx, 'avgSkip', 'len', args, 1))),
    stateful('countPresent', 'src len', (ctx, args) => countPresentStep(ctx.state, 'q', numberAt(args, 0), lengthAt(ctx, 'countPresent', 'len', args, 1))),
    stateful('count', 'cond len', (ctx, args) => countStep(ctx.state, 'q', boolAt(args, 0), lengthAt(ctx, 'count', 'len', args, 1))),
    stateful('cum', 'src', (ctx, args) => cumStep(ctx.state, 't', numberAt(args, 0))),
    stateful('rising', 'src len', (ctx, args) => runStep(ctx.state, 'q', numberAt(args, 0), lengthAt(ctx, 'rising', 'len', args, 1), true)),
    stateful('falling', 'src len', (ctx, args) => runStep(ctx.state, 'q', numberAt(args, 0), lengthAt(ctx, 'falling', 'len', args, 1), false)),
    crossing('crossUp', 'up'),
    crossing('crossDown', 'down'),
    crossing('cross', 'either'),
    stateful('barsSince', 'cond', (ctx, args) => barsSinceStep(ctx.state, 's', boolAt(args, 0))),
    // An absent occurrence is the most recent hit, which is what the declared
    // default of the call says.
    stateful('valueWhen', 'cond src occurrence', (ctx, args) => valueWhenStep(ctx.state, 'v', { cond: boolAt(args, 0), src: numberAt(args, 1) }, numberAt(args, 2) ?? 0)),
    stateful('median', 'src len', (ctx, args) => percentileStep(ctx.state, 'q', numberAt(args, 0), lengthAt(ctx, 'median', 'len', args, 1), 50)),
    stateful('percentile', 'src len p', (ctx, args) => percentileStep(ctx.state, 'q', numberAt(args, 0), lengthAt(ctx, 'percentile', 'len', args, 1), numberAt(args, 2))),
    stateful('pivotHigh', 'src left right', (ctx, args) => pivotStep(ctx.state, 'q', numberAt(args, 0), lengthAt(ctx, 'pivotHigh', 'left', args, 1), lengthAt(ctx, 'pivotHigh', 'right', args, 2), true)),
    stateful('pivotLow', 'src left right', (ctx, args) => pivotStep(ctx.state, 'q', numberAt(args, 0), lengthAt(ctx, 'pivotLow', 'left', args, 1), lengthAt(ctx, 'pivotLow', 'right', args, 2), false)),
    stateful('percentRank', 'src len', (ctx, args) => percentRankStep(ctx.state, 'q', numberAt(args, 0), lengthAt(ctx, 'percentRank', 'len', args, 1))),
    stateful('correlation', 'a b len', (ctx, args) => correlationStep(ctx.state, '', { a: numberAt(args, 0), b: numberAt(args, 1) }, lengthAt(ctx, 'correlation', 'len', args, 2))),
    stateful('covariance', 'a b len', (ctx, args) => covarianceStep(ctx.state, '', { a: numberAt(args, 0), b: numberAt(args, 1) }, lengthAt(ctx, 'covariance', 'len', args, 2))),
];
//# sourceMappingURL=series.js.map