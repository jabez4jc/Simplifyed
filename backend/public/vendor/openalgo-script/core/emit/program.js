/**
 * The compiled program, as `compiled-program.md` section 2 defines it.
 *
 * This file is the artifact's shape and nothing else: no logic, no defaults, no
 * decisions. It is separate because the artifact is the public contract of the
 * project. Somebody implementing an engine in another language reads the
 * specification and then reads this to check the two agree, and a type with a
 * field the specification does not have, or missing one it does, is the defect
 * no test of our own engine would ever catch.
 *
 * Field order here follows the specification's. It is not the order canonical
 * encoding writes: that one sorts keys, and `canonical.ts` is where it happens.
 */
export {};
//# sourceMappingURL=program.js.map