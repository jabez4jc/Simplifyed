/** A number the host stated, or absence when it stated none. */
export function hostNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
export function hostString(value) {
    return typeof value === 'string' ? value : null;
}
/** A condition the host stated, or absence when it stated none. */
export function hostBool(value) {
    return typeof value === 'boolean' ? value : null;
}
/**
 * The facts a library call reads, built over one host.
 *
 * The host is fetched through a function rather than captured, because a host
 * may be replaced between two runs of one engine and every read here has to see
 * the one in force now. Every entry is one row of `compiled-program.md` 5.2 and
 * there is no row that is not on that list.
 */
export function hostFactsFor(of, reads) {
    return {
        symbol: () => hostString(of().instrument?.symbol),
        exchange: () => hostString(of().instrument?.exchange),
        interval: () => hostString(of().instrument?.interval),
        timezone: () => hostString(of().instrument?.timezone),
        tickSize: () => hostNumber(of().instrument?.tickSize),
        lotSize: () => hostNumber(of().instrument?.lotSize),
        pointValue: () => hostNumber(of().instrument?.pointValue),
        currency: () => hostString(of().instrument?.currency),
        instrumentType: () => hostString(of().instrument?.instrumentType),
        hasVolume: () => hostBool(of().instrument?.hasVolume),
        hasOpenInterest: () => hostBool(of().instrument?.hasOpenInterest),
        now: () => hostNumber(of().now),
        requestReady: (id) => reads.answered(id),
        requestError: (id) => reads.failure(id),
    };
}
//# sourceMappingURL=host.js.map