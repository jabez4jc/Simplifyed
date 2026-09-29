/** The channels each output group owns, in the order `outputs` lists them. */
function declaredOrder(e) {
    const order = [];
    const take = (channel) => {
        if (typeof channel === 'number' && !order.includes(channel))
            order.push(channel);
    };
    for (const plot of e.plots) {
        take(plot.channel);
        take(plot.colorChannel);
        if (plot.ohlc === null)
            continue;
        take(plot.ohlc.open);
        take(plot.ohlc.high);
        take(plot.ohlc.low);
        take(plot.ohlc.close);
        take(plot.ohlc.colorUpChannel);
        take(plot.ohlc.colorDownChannel);
        take(plot.ohlc.wickColorChannel);
        take(plot.ohlc.borderColorChannel);
    }
    for (const band of e.fills) {
        take(band.colorUpChannel);
        take(band.colorDownChannel);
    }
    for (const level of e.levels)
        take(level.channel);
    for (const marker of e.markers)
        take(marker.channel);
    for (const alert of e.alerts) {
        take(alert.condChannel);
        take(alert.messageChannel);
    }
    take(e.barColor?.channel);
    take(e.background?.channel);
    // A channel no declaration reached would be one nothing can draw, so this is
    // insurance against a future surface rather than a case that happens today.
    for (let id = 0; id < e.layout.channels.length; id += 1)
        take(id);
    return order;
}
export function orderChannels(e) {
    const order = declaredOrder(e);
    const moved = new Array(e.layout.channels.length).fill(0);
    order.forEach((old, index) => {
        moved[old] = index;
    });
    const channels = order.map((old, index) => {
        const channel = e.layout.channels[old];
        return {
            id: index,
            type: channel?.type ?? 'number',
            defer: channel?.defer ?? false,
            once: channel?.once ?? false,
        };
    });
    return { channels, names: order.map((old) => e.layout.channelNames[old] ?? ''), moved };
}
export function renumberCode(code, moved) {
    return code.map((instruction) => instruction[0] === 'EMIT'
        ? ['EMIT', moved[instruction[1] ?? 0] ?? 0]
        : instruction);
}
function move(moved, channel) {
    return channel === null ? null : (moved[channel] ?? channel);
}
export function renumberOutputs(e, moved) {
    return {
        plots: e.plots.map((plot) => ({
            ...plot,
            channel: move(moved, plot.channel) ?? plot.channel,
            colorChannel: move(moved, plot.colorChannel),
            ohlc: plot.ohlc === null
                ? null
                : {
                    ...plot.ohlc,
                    open: move(moved, plot.ohlc.open) ?? plot.ohlc.open,
                    high: move(moved, plot.ohlc.high) ?? plot.ohlc.high,
                    low: move(moved, plot.ohlc.low) ?? plot.ohlc.low,
                    close: move(moved, plot.ohlc.close) ?? plot.ohlc.close,
                    colorUpChannel: move(moved, plot.ohlc.colorUpChannel),
                    colorDownChannel: move(moved, plot.ohlc.colorDownChannel),
                    wickColorChannel: move(moved, plot.ohlc.wickColorChannel),
                    borderColorChannel: move(moved, plot.ohlc.borderColorChannel),
                },
        })),
        fills: e.fills.map((band) => ({
            ...band,
            colorUpChannel: move(moved, band.colorUpChannel),
            colorDownChannel: move(moved, band.colorDownChannel),
        })),
        levels: e.levels.map((level) => ({
            ...level,
            channel: move(moved, level.channel) ?? level.channel,
        })),
        markers: e.markers.map((marker) => ({
            ...marker,
            channel: move(moved, marker.channel) ?? marker.channel,
        })),
        tables: e.tables,
        alerts: e.alerts.map((alert) => ({
            ...alert,
            condChannel: move(moved, alert.condChannel) ?? alert.condChannel,
            messageChannel: move(moved, alert.messageChannel),
        })),
        barColor: e.barColor === null ? null : { channel: move(moved, e.barColor.channel) ?? 0 },
        background: e.background === null ? null : { channel: move(moved, e.background.channel) ?? 0 },
    };
}
//# sourceMappingURL=channels.js.map