import { closestName } from './suggest.js';
/** `ema(src, len)`, with a `?` on the parameters that carry a default. */
export function signatureText(name, parameters) {
    const written = parameters.map((one) => (one.optional ? `${one.name}?` : one.name));
    return `${name}(${written.join(', ')})`;
}
/** `2`, or `2 to 5` where some parameters have defaults. */
export function arityText(parameters) {
    const required = parameters.filter((one) => !one.optional).length;
    return required === parameters.length ? `${required}` : `${required} to ${parameters.length}`;
}
/** A call with the required parameters written in, for OS3012's example slot. */
function exampleCall(name, parameters) {
    const required = parameters.filter((one) => !one.optional).map((one) => one.name);
    return `${name}(${required.join(', ')})`;
}
/**
 * Fills the parameter list from the arguments as written.
 *
 * Positional arguments fill from the left and named ones fill by label, which
 * is the order `language.md` 11.2 allows. A positional argument after a named
 * one is OS3005 and is reported once rather than once per argument: the mistake
 * is the boundary, not each argument past it.
 */
export function bindArguments(checker, span, args, name, parameters) {
    const filled = parameters.map(() => undefined);
    const names = parameters.map((one) => one.name);
    let next = 0;
    let seenNamed = false;
    let extra = 0;
    let reportedOrder = false;
    for (const argument of args) {
        if (argument.label === undefined) {
            if (seenNamed && !reportedOrder) {
                checker.report('OS3005', argument.span, {});
                reportedOrder = true;
            }
            if (next >= parameters.length) {
                extra += 1;
                continue;
            }
            filled[next] = argument;
            next += 1;
            continue;
        }
        seenNamed = true;
        const label = argument.label.text;
        const index = names.indexOf(label);
        if (index < 0) {
            checker.report('OS3002', argument.label.span, {
                name,
                argument: label,
                names: names.join(', '),
                suggestion: closestName(label, names),
            });
            continue;
        }
        if (filled[index] !== undefined) {
            checker.report('OS3013', argument.span, { argument: label });
            continue;
        }
        filled[index] = argument;
    }
    if (extra > 0) {
        checker.report('OS3001', span, {
            name,
            expected: arityText(parameters),
            found: args.length,
            signature: signatureText(name, parameters),
        });
    }
    for (let i = 0; i < parameters.length; i += 1) {
        const parameter = parameters[i];
        if (parameter === undefined || parameter.optional || filled[i] !== undefined)
            continue;
        checker.report('OS3012', span, {
            name,
            argument: parameter.name,
            example: exampleCall(name, parameters),
        });
    }
    return filled;
}
//# sourceMappingURL=arguments.js.map