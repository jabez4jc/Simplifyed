/**
 * Scopes, and the name each source name is written as.
 *
 * Two rules of the source dialect differ from OpenScript's, and both are about
 * meaning rather than spelling. A declaration inside a block or a function
 * always makes a new name there, hiding any outer name it shares a spelling
 * with, where OpenScript updates the outer name instead and refuses to hide one
 * (`language.md` 12.2 and 12.3). And the source dialect's built-ins live behind
 * namespaces, so `rsi` or `step` is an ordinary name there and a library name or
 * a reserved word here.
 *
 * So a declaration that would hide a visible name is renamed with a number, and
 * a name OpenScript reserves or defines is renamed with `Value` after it. Every
 * new spelling is checked against every name the source uses anywhere and every
 * name OpenScript has, so a rename can never land on another name. Nothing
 * else is renamed: a name that collides with neither keeps its spelling, and
 * two sibling blocks may both declare it, as both languages allow.
 */
import { NAMESPACES, isLibraryName } from '../check/index.js';
import { canonicalNumber } from '../emit/index.js';
import { RESERVED_WORDS } from '../tokens/index.js';
/** Words OpenScript gives a meaning of its own outside the library. */
const DECLARATION_WORDS = ['study', 'strategy', 'limits', 'version'];
export class Scope {
    names = new Map();
    parent;
    constructor(parent) {
        this.parent = parent;
    }
    find(name) {
        return this.names.get(name) ?? this.parent?.find(name);
    }
    get isGlobal() {
        return this.parent === undefined;
    }
}
export class Namer {
    #taken;
    /** `used` is every identifier the source writes, anywhere. */
    constructor(used) {
        this.#taken = new Set(used);
    }
    /** Whether OpenScript already means something by this name. */
    static reserved(name) {
        return (RESERVED_WORDS.includes(name) ||
            isLibraryName(name) ||
            NAMESPACES.includes(name) ||
            DECLARATION_WORDS.includes(name));
    }
    /** A spelling no source name and no OpenScript name has, starting from `base`. */
    fresh(base) {
        let candidate = base;
        for (let n = 2; this.#taken.has(candidate) || Namer.reserved(candidate); n += 1) {
            candidate = `${base}${canonicalNumber(n)}`;
        }
        this.#taken.add(candidate);
        return candidate;
    }
    /**
     * The spelling of a source name declared in `scope`.
     *
     * `hides` says whether an enclosing scope can already see the name, which is
     * the case the source dialect reads as a new name and OpenScript would read
     * as an update of the old one.
     */
    declare(name, hides) {
        if (Namer.reserved(name))
            return this.fresh(`${name}Value`);
        if (hides)
            return this.fresh(name);
        return name;
    }
}
/** A binding with the defaults a plain declaration has. */
export function binding(output, kind, topLevel) {
    return { output, kind, topLevel, handle: undefined, present: false, whole: false, labels: undefined };
}
//# sourceMappingURL=names.js.map