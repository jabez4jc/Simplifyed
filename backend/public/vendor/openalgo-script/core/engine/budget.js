import { raise } from './errors.js';
/**
 * What an engine allows when a host says nothing.
 *
 * The ceilings that have a catalogue code are set; the clock is off, because a
 * default wall clock would make the same script pass on a fast machine and fail
 * on a slow one with nobody having asked for that trade.
 *
 * **`arrayElements` is the one number here the language fixes.** `language.md`
 * 14.1 states it, so it is not a host's choice and a host lowering it refuses a
 * script that a conforming engine runs. `scripts/check-limits.mjs` compares it
 * against that sentence on every build, which is the only reason this file may
 * write the number at all. Every other ceiling below is the host's, because the
 * specification leaves it open.
 */
export const DEFAULT_LIMITS = {
    steps: null,
    ms: null,
    arrayElements: 1_000_000,
    stringLength: 100_000,
    drawingObjects: 10_000,
    frames: 64,
    loops: null,
    history: null,
    instructions: null,
    states: null,
    requests: null,
    clockEvery: 4096,
};
export function limitsWith(given) {
    return given === undefined ? DEFAULT_LIMITS : { ...DEFAULT_LIMITS, ...given };
}
/**
 * The most instructions one bar of this program can possibly execute.
 *
 * Verification proves three things that together bound a bar: the target of
 * every backward jump is a `TICK` (3.5 check 6), so no cycle runs without
 * charging the loop budget; recursion is an error, so the call graph is acyclic
 * and each call site's body runs at most once per acyclic segment; and the
 * instruction lists are finite. So a segment between two `TICK` executions
 * costs at most the program's whole instruction count once, and there are at
 * most `limits.loops` such segments plus the one that ends at `HALT`.
 *
 * The number is generous by design. It is not a performance budget: it is the
 * proof that a bar terminates, turned into a counter so that a program which
 * somehow exceeds its own static bound stops instead of running forever.
 */
export function stepBound(program) {
    let acyclic = program.code.length;
    for (const site of program.callSites) {
        acyclic += program.functions[site.fn]?.code.length ?? 0;
    }
    const segments = Math.max(program.limits.loops, 0) + 1;
    return Math.max(acyclic, 1) * segments + acyclic;
}
/**
 * The per-bar counters.
 *
 * One object per engine, reset at step 3 of every execution of a bar, so a long
 * dataset is never itself a reason to fail.
 */
export class Budget {
    loops = 0;
    steps = 0;
    started = 0;
    nextClockAt = 0;
    bar = 0;
    limits;
    stepCeiling;
    loopCeiling;
    clock;
    constructor(limits, stepCeiling, loopCeiling, clock) {
        this.limits = limits;
        this.stepCeiling = stepCeiling;
        this.loopCeiling = loopCeiling;
        this.clock = clock;
    }
    /** Step 3: the counters start again for this execution of this bar. */
    begin(bar) {
        this.bar = bar;
        this.loops = 0;
        this.steps = 0;
        this.nextClockAt = this.limits.clockEvery;
        this.started = this.limits.ms !== null && this.clock !== undefined ? this.clock() : 0;
    }
    /**
     * One instruction executed.
     *
     * Returns whether a budget is spent, rather than raising, so the dispatch
     * loop does the check inline and the cost is one comparison on the path every
     * instruction takes.
     */
    step() {
        this.steps += 1;
        if (this.steps > this.stepCeiling)
            return true;
        if (this.steps >= this.nextClockAt) {
            this.nextClockAt = this.steps + this.limits.clockEvery;
            if (this.clock !== undefined && this.limits.ms !== null) {
                return this.clock() - this.started > this.limits.ms;
            }
        }
        return false;
    }
    /** Which budget the last `step` ran out of, and the diagnostic for it. */
    overrun(span, loopLine) {
        const max = this.limits.ms;
        if (this.steps <= this.stepCeiling && max !== null && this.clock !== undefined) {
            raise('OS5007', span, { bar: this.bar, ms: this.clock() - this.started, max });
        }
        // The step ceiling is the static bound of `stepBound`, and a loop is the
        // only construct that can approach it, so the loop that was running is the
        // one to name. A bar that passes it with no loop running contradicts what
        // verification proved about the program, which is OS6018's case.
        this.spentLoops(span, loopLine);
    }
    /** Step 5.5: one iteration of loop `l` charged to the per-bar budget. */
    tick(span, line) {
        this.loops += 1;
        if (this.loops > this.loopCeiling)
            this.spentLoops(span, line);
    }
    spentLoops(span, line) {
        if (line === undefined) {
            raise('OS6018', span, {
                location: `step ${this.steps}`,
                reason: 'the bar executed more instructions than the program can reach without a loop, ' +
                    'so the instruction list is not the one verification walked',
            });
        }
        raise('OS5001', span, {
            budget: this.loopCeiling,
            line,
            suggested: suggestBudget(this.loopCeiling),
        });
    }
    /**
     * The drawing object ceiling, OS5010, charged before the object is built.
     *
     * `held` is what the script holds now, so the object about to be created is
     * number `held + 1` and the refusal names that number. Checked before
     * building rather than after, because an engine that allocates first and
     * complains second has already spent the memory it is refusing to spend.
     */
    checkDrawing(span, held) {
        if (held >= this.limits.drawingObjects) {
            raise('OS5010', span, { max: this.limits.drawingObjects, found: held + 1 });
        }
    }
    /** The array ceiling, OS5002. */
    checkArray(span, name, size) {
        if (size > this.limits.arrayElements) {
            raise('OS5002', span, { max: this.limits.arrayElements, name, size });
        }
    }
    /** The string ceiling, OS5008, counted in code points as 3.1 requires. */
    checkString(span, text) {
        this.checkLength(span, [...text].length);
        return text;
    }
    /**
     * The same ceiling against a length that has not been built yet.
     *
     * `str.repeat` is where a string ceiling is actually reached, and building
     * the string first to measure it is how an engine runs out of memory instead
     * of reporting that it would have.
     */
    checkLength(span, length) {
        if (length > this.limits.stringLength) {
            raise('OS5008', span, { max: this.limits.stringLength, found: length });
        }
    }
}
/**
 * A budget with room to spare, for OS5001's fix line.
 *
 * The catalogue asks for a budget that would have completed the bar, and the
 * engine cannot know one: it stopped the loop rather than finishing it. Twice
 * the budget, rounded to one significant figure so the number reads like
 * something a person would type, is the nearest honest thing, and the message
 * beside it says the first fix is the exit condition.
 */
function suggestBudget(budget) {
    const doubled = Math.max(budget * 2, 1000);
    const magnitude = Math.pow(10, Math.floor(Math.log10(doubled)));
    return Math.ceil(doubled / magnitude) * magnitude;
}
//# sourceMappingURL=budget.js.map