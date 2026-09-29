import { canonicalise } from '../emit/index.js';
import { BAR_FIELDS } from './bars.js';
import { limitsWith } from './budget.js';
import { Engine } from './engine.js';
import { NO_POSITION, failure, malformed } from './errors.js';
import { resolveInputs, utcTime } from './inputs.js';
import { planRequests } from './request-plan.js';
import { recordProblem } from './session/index.js';
import { capabilitiesFor, verify } from './verify.js';
/**
 * Loads a compiled program.
 *
 * Verification runs first and in full (3.5), then the refusals a host makes,
 * then input resolution. Nothing is executed until all three pass, so a program
 * that cannot run says so before a chart has drawn anything.
 */
export function load(program, options = {}) {
    const limits = limitsWith(options.limits);
    const host = options.host ?? {};
    const checked = verify(program, {
        capabilities: capabilitiesFor(host.route !== undefined, host.requestBars !== undefined),
        limits,
    });
    if (!checked.ok)
        return { ok: false, diagnostic: checked.diagnostic };
    const unknownField = checked.program.series.find((one) => one.kind === 'bar' && (one.field === null || !BAR_FIELDS.includes(one.field)));
    if (unknownField !== undefined) {
        return {
            ok: false,
            diagnostic: malformed(`series[${unknownField.id}].field`, `${String(unknownField.field)} is not a bar field this engine can fill`),
        };
    }
    // The instrument record is read once and is the same for every program, so a
    // record that contradicts itself is refused here rather than turning into an
    // absence each study explains for itself.
    const record = recordProblem(host.instrument?.session, host.instrument?.timezone ?? null);
    if (record !== undefined) {
        return {
            ok: false,
            diagnostic: failure('OS6012', NO_POSITION, {
                fact: record,
                symbol: host.instrument?.symbol ?? 'the chart\'s instrument',
            }),
        };
    }
    const resolved = resolveInputs(checked.program, options.settings ?? {}, options.time ?? utcTime);
    if (!resolved.ok)
        return { ok: false, diagnostic: resolved.diagnostic };
    // 2.16: a request's identity is fixed before bar 0, so it is settled here,
    // along with the two refusals that are facts about the program and the chart
    // rather than answers from the host: a timeframe the language does not know,
    // and one that cannot be folded onto this chart's bars.
    const planned = planRequests(checked.program.requests, resolved.inputs, host);
    if (!planned.ok)
        return { ok: false, diagnostic: planned.diagnostic };
    return {
        ok: true,
        engine: new Engine(checked.program, resolved.inputs, options, limits, planned.plans),
        inputs: resolved.inputs,
    };
}
/**
 * Loads a compiled program from text, which is where canonicity is required.
 *
 * `load` takes a parsed object because a host that compiled in this process
 * never serialised, and there is nothing for such an object to be canonical
 * about. Text is the other boundary, `compiled-program.md` 9.4 step 1 and
 * section 13 (decision 57): a program an engine reads from outside its process
 * arrives as the canonical encoding of 2.14, and text that parses to a program
 * but is not that encoding is refused, because the hash a host recorded was
 * taken over canonical bytes and text in any other spelling is text that hash
 * does not name. So the text is parsed, written out again by the one canonical
 * writer, and the two are compared character for character. Either failure is
 * OS6018 naming where the text stops being readable or stops being canonical,
 * counted in characters of the text, which is where an editor's cursor lands.
 *
 * What passes here is the object `load` verifies from step 2 on, so every
 * refusal that applies to an object applies to text as well and in the same
 * order.
 */
export function loadText(text, options = {}) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (thrown) {
        const message = thrown instanceof Error ? thrown.message : String(thrown);
        const at = /position (\d+)/.exec(message);
        return {
            ok: false,
            diagnostic: malformed(at === null ? 'the text' : `character ${at[1]}`, 'the text stops being the object notation of section 2.14 there, so it is not a program'),
        };
    }
    let canonical;
    try {
        canonical = canonicalise(parsed);
    }
    catch (thrown) {
        const message = thrown instanceof Error ? thrown.message : String(thrown);
        return {
            ok: false,
            diagnostic: malformed('the text', `it parses but cannot be written in the canonical form: ${message}`),
        };
    }
    if (canonical !== text) {
        return {
            ok: false,
            diagnostic: malformed(`character ${firstDifference(text, canonical)}`, 'the text is not the canonical encoding of the program it parses to, and a program ' +
                'read from outside the process has to be, because that is what its hash was taken over'),
        };
    }
    return load(parsed, options);
}
/** Where two texts part, as an index into either, or the shorter one's length. */
function firstDifference(a, b) {
    const shorter = Math.min(a.length, b.length);
    for (let i = 0; i < shorter; i += 1) {
        if (a[i] !== b[i])
            return i;
    }
    return shorter;
}
//# sourceMappingURL=load.js.map