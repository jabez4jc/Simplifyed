/**
 * Settling a translation: what is kept, what it reads, and whether it compiles.
 *
 * The importer promises that what it hands back compiles, and the promise is
 * kept by compiling it rather than by trusting the translators. Three passes
 * repeat until nothing changes:
 *
 * 1. **The cascade.** A statement that reads a top level name declared by a
 *    statement that was not kept is not kept either (OS9005), in source order,
 *    so one refusal is reported once at its cause and once at each statement
 *    that follows from it.
 * 2. **The rendering.** Kept statements are written out; the rest are written
 *    as their source lines behind a comment marker, so the original is there to
 *    translate from and nothing in them is compiled.
 * 3. **The compile.** Every error the compiler raises is laid at the statement
 *    whose line it is on, which is then not kept (OS9012), and the loop runs
 *    again. It ends when the output compiles, or when an error lies somewhere no
 *    statement owns, which only the declaration can be.
 *
 * Warnings the compiler raises are left for the reader's own compile to show:
 * they are about the output as OpenScript and say so in its own words.
 */
import { check } from '../check/index.js';
import { DiagnosticBag, diagnosticFor } from '../diagnostics/index.js';
import { emit } from '../emit/index.js';
import { lex } from '../lex/index.js';
import { parseTokens } from '../parse/index.js';
import { sourceFile } from '../source/index.js';
import { isKept, reasonOf } from './context.js';
const INDENT = '    ';
function cascade(ctx, nodes) {
    const lost = new Map();
    for (const node of nodes) {
        node.lost = undefined;
        if (node.refusal === undefined && node.failed === undefined) {
            const hit = node.reads.find((read) => lost.has(read.name));
            if (hit !== undefined) {
                node.lost = diagnosticFor('OS9005', ctx.span(hit.at), { name: hit.name, line: lost.get(hit.name) ?? 0 });
            }
        }
        if (!isKept(node))
            for (const one of node.declares)
                lost.set(one.name, node.lines.first);
    }
}
/** The output text, and for each of its lines the statement that wrote it. */
function render(file, pieces) {
    const lines = [];
    const owners = [];
    const push = (text, owner) => {
        if (text === '' && (lines.length === 0 || lines[lines.length - 1] === ''))
            return;
        lines.push(text);
        owners.push(owner);
    };
    for (const piece of pieces) {
        if (piece.kind === 'blank')
            push('', undefined);
        else if (piece.kind === 'text')
            push(piece.text, undefined);
        else if (piece.kind === 'remark')
            push(`${INDENT.repeat(piece.depth)}//${piece.remark.text}`, undefined);
        else if (isKept(piece.node)) {
            for (const line of piece.node.output) {
                push(line.text === '' ? '' : `${INDENT.repeat(line.depth)}${line.text}`, piece.node);
            }
        }
        else {
            const code = reasonOf(piece.node)?.code ?? '';
            for (let line = piece.node.lines.first; line <= piece.node.lines.last; line += 1) {
                push(`// not translated (${code}): ${file.lineText(line)}`.trimEnd(), piece.node);
            }
        }
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
        owners.pop();
    }
    return { text: `${lines.join('\n')}\n`, owners };
}
/** The errors OpenScript's own compiler raises on a text. */
function compileErrors(text) {
    const file = sourceFile('translation.oscript', text);
    const bag = new DiagnosticBag();
    const tokens = lex(file, bag);
    const script = parseTokens(file, tokens, bag);
    const checked = check(file, script, bag);
    if (!bag.hasErrors)
        emit(file, checked, bag, {});
    return bag.errors;
}
/** Repeats the three passes until the output compiles or nothing more can be done. */
export function settle(ctx, nodes, pieces) {
    for (let pass = 0;; pass += 1) {
        cascade(ctx, nodes);
        const { text, owners } = render(ctx.facts.file, pieces);
        const errors = compileErrors(text);
        let changed = false;
        for (const error of errors) {
            const owner = owners[error.span.line - 1];
            if (owner === undefined || !isKept(owner))
                continue;
            if (owner.declaration) {
                owner.notes.push({ diagnostic: diagnosticFor('OS9012', ctx.span(owner.stmt.at), { code: error.code }), once: 'declaration' });
                continue;
            }
            owner.failed = diagnosticFor('OS9012', ctx.span(owner.stmt.at), { code: error.code });
            changed = true;
        }
        if (!changed || pass > nodes.length)
            return text;
    }
}
/** Every finding, in the order a reader walks the source. */
export function findingsOf(nodes) {
    const bag = new DiagnosticBag();
    const once = new Set();
    for (const node of nodes) {
        const reason = reasonOf(node);
        if (reason !== undefined) {
            bag.add(reason);
            continue;
        }
        for (const note of node.notes) {
            if (note.once !== undefined) {
                if (once.has(note.once))
                    continue;
                once.add(note.once);
            }
            bag.add(note.diagnostic);
        }
    }
    return bag.ordered();
}
//# sourceMappingURL=settle.js.map