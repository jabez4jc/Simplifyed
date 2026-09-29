import { Checker, TOP_LEVEL, finaliseStorage } from './checker.js';
import { checkDeclaration, checkLimits, readHeader } from './declaration.js';
import { reportDeletedStillHeld } from './deleted.js';
import { checkFunctionDeclarations, checkRemainingFunctions } from './functions.js';
import { reportRepeatedAlertIds } from './outputs.js';
import { checkStatement } from './statements.js';
import { reportUnplaceableTags } from './tags.js';
import { elementOf, isHandle } from './types.js';
export function check(file, script, sink) {
    const checker = new Checker(file, script, sink);
    readHeader(checker, script);
    checkFunctionDeclarations(checker, script);
    let limits = false;
    for (const item of script.items) {
        switch (item.kind) {
            case 'functionDeclaration':
                continue;
            case 'scriptDeclaration':
                checkDeclaration(checker, item);
                continue;
            case 'limitsLine':
                checkLimits(checker, item, script, limits);
                limits = true;
                continue;
            default:
                checkStatement(checker, item, TOP_LEVEL);
        }
    }
    checkRemainingFunctions(checker);
    finaliseStorage(checker);
    reportUnknownElementTypes(checker);
    reportNamesNeverRead(checker);
    reportDeletedStillHeld(checker);
    reportRepeatedTitles(checker);
    reportInputKeys(checker);
    reportRepeatedAlertIds(checker);
    reportUnplaceableTags(checker);
    return checker.finish();
}
/**
 * OS2015: an empty array literal that never learned what it holds.
 *
 * `language.md` 14.1 gives one its element type from an annotation or from the
 * first `push`, `unshift`, `insert` or `set` in the file. With neither, there
 * is no type, and the moment to say so is now rather than at the literal, where
 * the insertion three lines below had not been read yet.
 */
function reportUnknownElementTypes(checker) {
    for (const binding of checker.bindings) {
        const type = elementOf(binding.type);
        if (type.kind !== 'array' || type.element.kind !== 'unknown')
            continue;
        checker.report('OS2015', binding.declaredAt, {});
    }
}
/**
 * OS8010 and OS8018: a name, or an input, that nothing in the file reads.
 *
 * A name bound to a declaration handle is exempt, as the entry's cause says: a
 * handle is a compile-time binding, the declaration draws whether or not it is
 * named, and so nothing is left in the bar loop for the warning to be about.
 * `language.md` 5.4 gives `plot`, `plotCandles`, `fill` and `level` the one kind
 * of value, so the exemption is the type rather than a list of the two calls
 * `stdlib.md` 14.2 happens to name.
 */
function reportNamesNeverRead(checker) {
    for (const binding of checker.bindings) {
        if (binding.isRead)
            continue;
        if (binding.kind === 'library' || binding.kind === 'function')
            continue;
        if (binding.kind === 'parameter' || binding.kind === 'loop')
            continue;
        if (isHandle(binding.type))
            continue;
        if (binding.input !== undefined) {
            const input = checker.inputs[binding.input];
            checker.report('OS8018', binding.declaredAt, {
                title: `"${input?.title ?? binding.name}"`,
                line: binding.declaredAt.line,
            });
            continue;
        }
        checker.report('OS8010', binding.declaredAt, {
            name: binding.name,
            line: binding.declaredAt.line,
        });
    }
}
/**
 * OS3017: two things in one file given the same name.
 *
 * A title is what every later stage keys on, from a legend entry to a saved
 * alert subscription, so two of them is not a cosmetic problem: one of the two
 * would have to lose, and nothing anywhere decides which.
 */
function reportRepeatedTitles(checker) {
    const seen = new Map();
    for (const output of checker.outputs) {
        if (output.form === 'fill' || output.title === '')
            continue;
        const key = `${output.form}:${output.title}`;
        const first = seen.get(key);
        if (first === undefined)
            seen.set(key, output.span.line);
        else {
            checker.report('OS3017', output.span, {
                kind: output.form,
                name: `"${output.title}"`,
                line: first,
            });
        }
    }
    const inputs = new Map();
    for (const input of checker.inputs) {
        if (input.title === '')
            continue;
        const first = inputs.get(input.title);
        if (first === undefined)
            inputs.set(input.title, input.span.line);
        else {
            checker.report('OS3017', input.span, {
                kind: 'input',
                name: `"${input.title}"`,
                line: first,
            });
        }
    }
}
/**
 * OS3021, OS3024 and OS3022: an input whose settings key is missing, or is
 * another's.
 *
 * `host-interface.md` 8.1 keys a stored value by the name the input was
 * assigned to, and an input written where a value belongs is assigned to none.
 * Its key is its title instead: the one thing about the row a user sees, and
 * therefore the one thing whose change is a rename rather than an edit. That
 * holds only while every input lands on a key of its own, and there are exactly
 * two ways it does not. A title spelling another input's name puts two rows on
 * one key, and one user value would serve both. A title that is not there at
 * all is no key and no label either.
 *
 * **No title and an empty title are two programs and take two codes.** Both end
 * with nothing to be keyed by, and a reader who wrote `input(14, "")` did write
 * a title as a string literal, so OS3021's message and its fix are both untrue
 * of their file: they tell them to do the thing they have just done. OS3024 is
 * the same refusal with a sentence that is true of it, and it refines OS3021
 * rather than widening it, because the two fixes are different edits.
 *
 * Two inputs carrying one title is the third way and is OS3017 above, which is
 * why this runs after it: the case is already reported and reporting it twice
 * would be two codes for one edit.
 */
function reportInputKeys(checker) {
    const names = new Map();
    for (const input of checker.inputs) {
        if (input.name !== '')
            names.set(input.name, input.span.line);
    }
    for (const input of checker.inputs) {
        if (input.name !== '')
            continue;
        if (input.title === '') {
            if (input.titleWritten)
                checker.report('OS3024', input.span, {});
            else
                checker.report('OS3021', input.span, {});
            continue;
        }
        const taken = names.get(input.title);
        if (taken === undefined)
            continue;
        checker.report('OS3022', input.span, { name: `"${input.title}"`, line: taken });
    }
}
//# sourceMappingURL=check.js.map