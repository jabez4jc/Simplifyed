import { inputHeldBy } from '../check/index.js';
import { inputKey } from './context.js';
/**
 * `stdlib.md` 15.4 lets an expression inside a read name a setting and nothing
 * else of the file, because a setting resolves before bar 0 and holds for the
 * run while a per-bar name has no counterpart on the requested bars. Each one
 * read here is filled into a register of the body's own table, named by
 * `inputs` on the request (2.16).
 */
export class RequestScope {
    inputs = [];
    byInput = new Map();
    /** The register a setting is filled into, or nothing when this is not one. */
    registerFor(e, binding) {
        const held = inputHeldBy(binding);
        if (held === undefined)
            return undefined;
        const input = e.checked.inputs[held];
        return input === undefined ? undefined : this.registerForInput(e, input);
    }
    /**
     * The same register for an `input()` written inside the expression itself.
     *
     * The two forms are one question. `stdlib.md` 15.4 lets a read's expression
     * name a setting because a setting resolves before bar 0 and holds for the
     * run, and that is a fact about the input rather than about whether a name
     * was put in front of it. So both resolve here, keyed by the input, and two
     * reads of one setting inside one body share one register rather than asking
     * the engine to fill the same value twice.
     */
    registerForInput(e, input) {
        const found = this.byInput.get(input.id);
        if (found !== undefined)
            return found;
        const register = e.layout.filled('input', inputKey(input));
        this.byInput.set(input.id, register);
        this.inputs.push({ input: inputKey(input), series: register });
        return register;
    }
}
//# sourceMappingURL=request-scope.js.map