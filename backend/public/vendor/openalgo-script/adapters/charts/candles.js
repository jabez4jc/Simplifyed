import { cssColour } from './colours.js';
import { colourAt, colourColumns } from './columns.js';
import { colourField } from './fields.js';
export function buildCandle(key, ohlc, lookup) {
    const keys = {
        open: `${key}:open`,
        high: `${key}:high`,
        low: `${key}:low`,
        close: `${key}:close`,
    };
    const up = colourField(ohlc.colorUp, lookup);
    const down = colourField(ohlc.colorDown, lookup);
    const wick = colourField(ohlc.wickColor, lookup);
    const border = colourField(ohlc.borderColor, lookup);
    const borderUp = border ?? up;
    const borderDown = border ?? down;
    const wickUp = wick ?? up;
    const wickDown = wick ?? down;
    const style = {
        ...(up === undefined ? {} : { upColor: cssColour(up) }),
        ...(down === undefined ? {} : { downColor: cssColour(down) }),
        ...(borderUp === undefined ? {} : { borderUpColor: cssColour(borderUp) }),
        ...(borderDown === undefined ? {} : { borderDownColor: cssColour(borderDown) }),
        ...(wickUp === undefined ? {} : { wickUpColor: cssColour(wickUp) }),
        ...(wickDown === undefined ? {} : { wickDownColor: cssColour(wickDown) }),
    };
    const columns = [
        { key: keys.open, channel: ohlc.open, part: 'value' },
        { key: keys.high, channel: ohlc.high, part: 'value' },
        { key: keys.low, channel: ohlc.low, part: 'value' },
        { key: keys.close, channel: ohlc.close, part: 'value' },
    ];
    const parts = [
        { name: `${key}:up`, channel: ohlc.colorUpChannel },
        { name: `${key}:down`, channel: ohlc.colorDownChannel },
        { name: `${key}:wick`, channel: ohlc.wickColorChannel },
        { name: `${key}:border`, channel: ohlc.borderColorChannel },
    ];
    for (const part of parts) {
        if (part.channel !== null)
            columns.push(...colourColumns(part.name, part.channel));
    }
    const perBar = parts.some((one) => one.channel !== null);
    return {
        ohlc: keys,
        style,
        columns,
        colorParts: perBar
            ? (ctx) => {
                const rising = isRising(ctx, keys.open, keys.close);
                const bodyChannel = rising ? ohlc.colorUpChannel : ohlc.colorDownChannel;
                const body = bodyChannel === null
                    ? undefined
                    : colourAt(ctx.values, ctx.index, rising ? `${key}:up` : `${key}:down`);
                const wickPart = override(ctx, `${key}:wick`, ohlc.wickColorChannel, wick, body);
                const borderPart = override(ctx, `${key}:border`, ohlc.borderColorChannel, border, body);
                return {
                    ...(body === undefined ? {} : { body }),
                    ...(wickPart === undefined ? {} : { wick: wickPart }),
                    ...(borderPart === undefined ? {} : { border: borderPart }),
                };
            }
            : undefined,
    };
}
/** Whether this bar closed at or above its own open, by the candle's columns. */
function isRising(ctx, openKey, closeKey) {
    const open = ctx.values[openKey]?.[ctx.index];
    const close = ctx.values[closeKey]?.[ctx.index];
    if (typeof open !== 'number' || typeof close !== 'number')
        return true;
    return close >= open;
}
/**
 * The wick or the border for one bar.
 *
 * Its own channel wins, then a declared constant, which the series style already
 * carries and this leaves alone, and otherwise the part follows the body.
 */
function override(ctx, name, channel, declared, body) {
    if (channel !== null)
        return colourAt(ctx.values, ctx.index, name);
    return declared === undefined ? body : undefined;
}
//# sourceMappingURL=candles.js.map