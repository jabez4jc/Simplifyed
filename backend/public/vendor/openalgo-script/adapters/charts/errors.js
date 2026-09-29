/** The name the chart's runtime reads for a condition a user can fix. */
const INPUT_ERROR = 'IndicatorInputError';
/** The name for a failure that is not about a setting. */
const SCRIPT_ERROR = 'OpenScriptError';
export class ChartAdapterError extends Error {
    diagnostic;
    constructor(diagnostic, name) {
        super(`${diagnostic.code}: ${diagnostic.message} ${diagnostic.fix}`);
        this.name = name;
        this.diagnostic = diagnostic;
    }
}
/** A refusal at load: the program never ran, so a setting is what to change. */
export function refused(diagnostic) {
    return new ChartAdapterError(diagnostic, INPUT_ERROR);
}
/** A failure on a bar: the program ran and stopped. */
export function stopped(diagnostic) {
    return new ChartAdapterError(diagnostic, SCRIPT_ERROR);
}
//# sourceMappingURL=errors.js.map