import { canonicalNumber } from '../emit/index.js';
import { Namer, Scope } from './names.js';
export function isKept(node) {
    return node.refusal === undefined && node.failed === undefined && node.lost === undefined;
}
/** The first reason a node is not kept, in the order the reasons are found. */
export function reasonOf(node) {
    return node.refusal ?? node.failed ?? node.lost;
}
export class Context {
    namer;
    fileScope = new Scope(undefined);
    scope = this.fileScope;
    /** The statement being translated. */
    node;
    /** Lines a statement needs evaluated before it, and whether it may have them. */
    hoisted = [];
    mayHoist = false;
    /** Inside a ternary arm, where the source dialect evaluates lazily as OpenScript does. */
    lazy = 0;
    depth = 0;
    /** The declaration's pyramiding, read as the source dialect reads it: 0 is 1. */
    pyramiding = 1;
    /**
     * Whether the declaration sizes orders in units. The source dialect counts a
     * quantity written on an entry in contracts whatever the declaration says,
     * and OpenScript counts it in the declaration's own unit.
     */
    qtyInUnits = true;
    titles = new Map();
    facts;
    constructor(facts) {
        this.facts = facts;
        this.namer = new Namer(facts.used);
    }
    span(at) {
        return this.facts.file.spanAt(at.offset, at.length);
    }
    /** Records the first reason the current statement cannot be translated. */
    refuse(diagnostic) {
        if (this.node !== undefined && this.node.refusal === undefined)
            this.node.refusal = diagnostic;
    }
    get refused() {
        return this.node?.refusal !== undefined;
    }
    note(diagnostic, once) {
        this.node?.notes.push({ diagnostic, once });
    }
    /** Whether declaring `name` in the current scope needs a new spelling to keep it apart. */
    hides(name) {
        return this.scope.find(name) !== undefined || (!this.scope.isGlobal && this.facts.globals.has(name));
    }
    /** The binding a source name has here, recording a read of a top level one. */
    lookup(name, at) {
        const found = this.scope.find(name);
        if (found !== undefined && found.topLevel)
            this.node?.reads.push({ name, at });
        return found;
    }
    /** Enters a block scope for the length of `work`. */
    within(work) {
        const outer = this.scope;
        this.scope = new Scope(outer);
        try {
            return work();
        }
        finally {
            this.scope = outer;
        }
    }
    /**
     * Moves an expression to its own line before the current statement, and
     * returns the name it is read under, or undefined where it cannot be moved.
     */
    hoist(text) {
        if (!this.mayHoist || this.lazy > 0)
            return undefined;
        const name = this.namer.fresh('everyBar');
        this.hoisted.push({ depth: this.depth, text: `${name} = ${text}` });
        return name;
    }
    /** A title for a declared output that no other output of its kind has. */
    title(kind, wanted) {
        let seen = this.titles.get(kind);
        if (seen === undefined) {
            seen = new Set();
            this.titles.set(kind, seen);
        }
        let title = wanted;
        for (let n = 2; seen.has(title); n += 1)
            title = `${wanted} ${canonicalNumber(n)}`;
        seen.add(title);
        return title;
    }
}
const HEX = '0123456789abcdef';
/** A string literal in OpenScript's spelling of it (`language.md` 3.6). */
export function quoted(value) {
    let out = '"';
    for (const c of value) {
        const code = c.codePointAt(0) ?? 0;
        if (c === '"')
            out += '\\"';
        else if (c === '\\')
            out += '\\\\';
        else if (c === '\n')
            out += '\\n';
        else if (c === '\t')
            out += '\\t';
        else if (c === '\r')
            out += '\\r';
        else if (code < 0x20)
            out += `\\u00${HEX[code >> 4] ?? '0'}${HEX[code & 15] ?? '0'}`;
        else
            out += c;
    }
    return `${out}"`;
}
//# sourceMappingURL=context.js.map