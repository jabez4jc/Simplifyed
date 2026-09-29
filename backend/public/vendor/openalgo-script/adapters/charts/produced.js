const NOTHING = { markers: [], tables: [], drawings: [], messages: [] };
const runs = new WeakMap();
/** What the calculation just produced, against the settings it was run with. */
export function remember(settings, produced) {
    runs.set(settings, produced);
}
/** What the last calculation for this instance produced, or nothing. */
export function producedFor(settings) {
    return runs.get(settings) ?? NOTHING;
}
//# sourceMappingURL=produced.js.map