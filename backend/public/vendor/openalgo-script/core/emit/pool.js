export const ABSENT_INDEX = 0;
export const FALSE_INDEX = 1;
export const TRUE_INDEX = 2;
export class ConstantPool {
    entries = [
        ['z', null],
        ['b', false],
        ['b', true],
    ];
    byKey = new Map([
        ['z', ABSENT_INDEX],
        ['b:false', FALSE_INDEX],
        ['b:true', TRUE_INDEX],
    ]);
    get all() {
        return this.entries;
    }
    absent() {
        return ABSENT_INDEX;
    }
    bool(value) {
        return value ? TRUE_INDEX : FALSE_INDEX;
    }
    number(value) {
        // A negative zero is normalised on every store (3.1), so the pool never
        // holds one and two scripts writing 0 and -0 share an entry.
        return this.intern(['n', value === 0 ? 0 : value], `n:${value === 0 ? 0 : value}`);
    }
    string(value) {
        return this.intern(['s', value], `s:${value}`);
    }
    colour(value) {
        return this.intern(['c', value], `c:${value.join(',')}`);
    }
    /** The pool index for a folded value, or nothing when it is not poolable. */
    of(value) {
        switch (value.kind) {
            case 'absent':
                return this.absent();
            case 'bool':
                return this.bool(value.value);
            case 'number':
                return this.number(value.value);
            case 'string':
                return this.string(value.value);
            case 'colour':
                return this.colour(value.value);
            default:
                return undefined;
        }
    }
    intern(entry, key) {
        const found = this.byKey.get(key);
        if (found !== undefined)
            return found;
        const index = this.entries.length;
        this.entries.push(entry);
        this.byKey.set(key, index);
        return index;
    }
}
/** A folded value as a constant entry, for an input's default and its options. */
export function constantOf(value) {
    switch (value.kind) {
        case 'absent':
            return ['z', null];
        case 'bool':
            return ['b', value.value];
        case 'number':
            return ['n', value.value];
        case 'string':
            return ['s', value.value];
        case 'colour':
            return ['c', value.value];
        default:
            return undefined;
    }
}
//# sourceMappingURL=pool.js.map