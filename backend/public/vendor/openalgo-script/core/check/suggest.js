/**
 * The near name a diagnostic offers when something was not found.
 *
 * Five codes promise one: OS2001, OS2009, OS2010, OS3002 and OS3008 each carry
 * a `suggestion` slot documented as the closest candidate by edit distance. So
 * the answer is the closest one and not the closest one within some threshold:
 * a threshold would leave the slot with nothing to put in it, and a message
 * with a hole in it is a defect a reader cannot report.
 *
 * The distance is Levenshtein over code units, computed with two rows rather
 * than a matrix because this runs once per unresolved name against every name
 * in scope, and an editor asks for it while somebody is still typing.
 */
/** The edit distance between two names, capped so a hopeless pair costs little. */
export function editDistance(left, right) {
    if (left === right)
        return 0;
    if (left.length === 0)
        return right.length;
    if (right.length === 0)
        return left.length;
    let previous = Array.from({ length: right.length + 1 }, (_unused, index) => index);
    let current = new Array(right.length + 1).fill(0);
    for (let i = 1; i <= left.length; i += 1) {
        current[0] = i;
        for (let j = 1; j <= right.length; j += 1) {
            const substitution = (previous[j - 1] ?? 0) + (left[i - 1] === right[j - 1] ? 0 : 1);
            const deletion = (previous[j] ?? 0) + 1;
            const insertion = (current[j - 1] ?? 0) + 1;
            current[j] = Math.min(substitution, deletion, insertion);
        }
        const swap = previous;
        previous = current;
        current = swap;
    }
    return previous[right.length] ?? Math.max(left.length, right.length);
}
/**
 * The closest candidate, or the written name when there are no candidates.
 *
 * Returning the written name happens only where a namespace holds nothing,
 * which the library never does, so it is a floor rather than an outcome. Case
 * is folded before comparing, because a name written with the wrong capital is
 * the commonest near miss of all and costs a full edit distance otherwise.
 */
export function closestName(written, candidates) {
    const target = written.toLowerCase();
    let best = written;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
        if (candidate === written)
            continue;
        const distance = editDistance(target, candidate.toLowerCase());
        if (distance < bestDistance) {
            best = candidate;
            bestDistance = distance;
        }
    }
    return best;
}
//# sourceMappingURL=suggest.js.map