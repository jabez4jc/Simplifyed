import { NO_POSITION, failure } from './errors.js';
/** Each ceiling in turn, stopping at the first the program is over. */
export function checkBudgets(program, limits) {
    if (limits.loops !== null && program.limits.loops > limits.loops) {
        return failure('OS5003', NO_POSITION, {
            option: 'loops',
            max: limits.loops,
            found: program.limits.loops,
        });
    }
    const history = program.limits.history;
    if (limits.history !== null && history !== null && history > limits.history) {
        return failure('OS5003', NO_POSITION, {
            option: 'history',
            max: limits.history,
            found: history,
        });
    }
    if (limits.instructions !== null) {
        let found = 0;
        for (const code of allCode(program))
            found += code.length;
        if (found > limits.instructions) {
            return failure('OS5009', NO_POSITION, { found, max: limits.instructions });
        }
    }
    if (limits.states !== null && program.states.length > limits.states) {
        const [first, second] = busiestPair(program);
        return failure('OS5004', NO_POSITION, {
            found: program.states.length,
            max: limits.states,
            first,
            second,
        });
    }
    if (limits.requests !== null) {
        // `host-interface.md` 5.2: the ceiling is the host's and it is stated at
        // load, because the whole set of reads is known then. A nested read is one
        // of them: it is a second series the host keeps in step with the chart.
        const found = countRequests(program.requests);
        if (found > limits.requests) {
            return failure('OS5006', NO_POSITION, { found, max: limits.requests });
        }
    }
    const depth = callDepth(program);
    if (depth > limits.frames) {
        return failure('OS5005', NO_POSITION, {
            construct: 'a call',
            found: depth,
            max: limits.frames,
        });
    }
    return undefined;
}
/** Every read the file makes, the ones written inside another included. */
function countRequests(requests) {
    let found = 0;
    for (const one of requests)
        found += 1 + countRequests(one.body.requests);
    return found;
}
/**
 * The opcode of one element of an instruction list, or nothing when it is not
 * an instruction at all.
 *
 * The budget refusals are step 7 of 9.4 and verification is step 8, so the two
 * walks below read lists that nothing has yet proved are instruction lists.
 * Reading them defensively is what keeps the specification's order from turning
 * a malformed program into a thrown error rather than the OS6018 step 8 is
 * about to report, naming the instruction.
 */
function opcodeOf(instruction) {
    return Array.isArray(instruction) ? instruction[0] : undefined;
}
/**
 * The two functions whose nesting produced the most call paths.
 *
 * OS5004's message names them because the number of paths grows
 * multiplicatively where several functions each call the next more than once,
 * and a reader who is told only the total has nowhere to start. The pair with
 * the most call sites between them is where the multiplication happened.
 */
function busiestPair(program) {
    const counts = new Map();
    const lists = [
        ['the top level', program.code],
        ...program.functions.map((one) => [one.name, one.code]),
    ];
    for (const [caller, code] of lists) {
        for (const instruction of code) {
            if (opcodeOf(instruction) !== 'CALL_FN')
                continue;
            const site = program.callSites[instruction[1]];
            const callee = site === undefined ? undefined : program.functions[site.fn]?.name;
            if (callee === undefined)
                continue;
            const key = `${caller}\u0000${callee}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
    }
    let best = ['the top level', 'the functions it calls'];
    let most = 0;
    // Sorted before the walk, so the answer does not depend on a map's order.
    for (const key of [...counts.keys()].sort()) {
        const count = counts.get(key) ?? 0;
        if (count <= most)
            continue;
        const [caller, callee] = key.split('\u0000');
        best = [caller ?? '', callee ?? ''];
        most = count;
    }
    return best;
}
/**
 * The deepest chain of call sites, which is the deepest the frame stack goes.
 *
 * Recursion is an error in the language, so the call graph is acyclic and the
 * walk terminates; the visited set is a guard against a program that was
 * written by something other than this compiler, and it stops rather than
 * looping forever.
 */
function callDepth(program) {
    const bodies = program.functions.map((one) => one.code);
    const sitesIn = (code) => code.flatMap((one) => opcodeOf(one) === 'CALL_FN' && typeof one[1] === 'number' ? [one[1]] : []);
    const known = new Map();
    const walking = new Set();
    const depthOf = (site) => {
        const cached = known.get(site);
        if (cached !== undefined)
            return cached;
        if (walking.has(site))
            return 1;
        walking.add(site);
        const fn = program.callSites[site]?.fn;
        const body = fn === undefined ? undefined : bodies[fn];
        let deepest = 0;
        for (const inner of body === undefined ? [] : sitesIn(body)) {
            deepest = Math.max(deepest, depthOf(inner));
        }
        walking.delete(site);
        known.set(site, deepest + 1);
        return deepest + 1;
    };
    let deepest = 0;
    for (const site of sitesIn(program.code))
        deepest = Math.max(deepest, depthOf(site));
    return deepest + 1;
}
/**
 * Every instruction list in the program, the bodies of its reads included.
 *
 * A read's expression is part of the program: an engine that cannot run an
 * `ELEM` cannot run one inside a read either, and a budget or a tag worked out
 * from the bar's list alone would say otherwise.
 */
export function allCode(program) {
    const lists = [
        program.code,
        ...program.functions.map((one) => one.code),
    ];
    const walk = (requests) => {
        for (const request of requests) {
            lists.push(request.body.code);
            for (const one of request.body.functions)
                lists.push(one.code);
            walk(request.body.requests);
        }
    };
    walk(program.requests);
    return lists;
}
//# sourceMappingURL=verify-budgets.js.map