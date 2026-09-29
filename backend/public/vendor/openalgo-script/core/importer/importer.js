/**
 * The importer: a script in the source dialect in, OpenScript and findings out.
 *
 * The source dialect is the widely used chart scripting language whose scripts
 * open with a version annotation comment, declare themselves with an
 * `indicator` or `strategy` call and reach their built-ins through namespaces
 * such as `ta` and `math`. Versions 5 and 6 are read.
 *
 * It is text to text and nothing else: no file is read, no global is touched
 * and nothing is evaluated. What it cannot translate faithfully it does not
 * approximate. A statement is translated whole, with the source dialect's
 * meaning, or kept as a comment line per source line and reported; a
 * translation whose meaning differs in a way the importer can state is written
 * and reported with a warning. Every finding points into the imported text.
 */
import { diagnosticFor } from '../diagnostics/index.js';
import { sourceFile } from '../source/index.js';
import { Context } from './context.js';
import { readItems } from './lexer.js';
import { binding } from './names.js';
import { declarationLine } from './orders.js';
import { readScript } from './parser.js';
import { findingsOf, settle } from './settle.js';
import { translateStatement } from './statements.js';
import { pathOf } from './syntax.js';
const ANNOTATION = /^\s*@version\s*=\s*(\d+)\s*$/;
/** The version annotation, if one comes before the first line of code. */
function annotationOf(items) {
    for (const item of items) {
        if (item.kind === 'code')
            return undefined;
        if (item.kind !== 'remark')
            continue;
        const found = ANNOTATION.exec(item.remark.text);
        if (found !== null)
            return { remark: item.remark, version: found[1] ?? '' };
    }
    return undefined;
}
function declaresOf(stmt) {
    switch (stmt.kind) {
        case 'declare':
        case 'function':
            return [stmt.name];
        case 'tuple':
            return stmt.names;
        case 'refused':
            return stmt.declares;
        default:
            return [];
    }
}
function nodeOf(stmt, declaration) {
    return {
        stmt,
        lines: stmt.lines,
        declares: declaresOf(stmt),
        reads: [],
        output: [],
        refusal: undefined,
        failed: undefined,
        lost: undefined,
        notes: [],
        declaration,
    };
}
function visit(body, each) {
    for (const entry of body) {
        if (entry.kind !== 'stmt')
            continue;
        const stmt = entry.stmt;
        each(stmt);
        if (stmt.kind === 'if') {
            for (const branch of stmt.branches)
                visit(branch.body, each);
            if (stmt.otherwise !== undefined)
                visit(stmt.otherwise, each);
        }
        else if (stmt.kind === 'for' || stmt.kind === 'while')
            visit(stmt.body, each);
        else if (stmt.kind === 'switch')
            for (const arm of stmt.arms)
                visit(arm.body, each);
        else if (stmt.kind === 'function' && Array.isArray(stmt.body))
            visit(stmt.body, each);
    }
}
/** The side each literal entry id opens, read from the script's entry calls. */
function entrySides(body) {
    const sides = new Map();
    visit(body, (stmt) => {
        if (stmt.kind !== 'evaluate' || stmt.expr.kind !== 'call')
            return;
        if (pathOf(stmt.expr.callee) !== 'strategy.entry')
            return;
        const args = stmt.expr.args;
        const id = args.find((arg) => arg.label === 'id') ?? args.find((arg, i) => arg.label === undefined && i === 0);
        const side = args.find((arg) => arg.label === 'direction') ?? args.filter((arg) => arg.label === undefined)[1];
        const direction = side === undefined ? undefined : pathOf(side.value);
        if (id?.value.kind !== 'string')
            return;
        if (direction === 'strategy.long')
            sides.set(id.value.value, 'long');
        if (direction === 'strategy.short')
            sides.set(id.value.value, 'short');
    });
    return sides;
}
function reassignments(body) {
    const found = new Map();
    visit(body, (stmt) => {
        if (stmt.kind !== 'assign')
            return;
        const held = found.get(stmt.name.name) ?? [];
        held.push({ op: stmt.op, value: stmt.value });
        found.set(stmt.name.name, held);
    });
    return found;
}
function refusal(diagnostic) {
    return { source: '', findings: [diagnostic] };
}
/** Zero width, where the first statement starts: where a declaration was expected. */
function firstStatement(file, body) {
    const first = body.find((entry) => entry.kind === 'stmt');
    return first?.kind === 'stmt' ? file.spanAt(first.stmt.at.offset, 0) : file.spanAt(file.text.length, 0);
}
function declarationOf(body) {
    for (const entry of body) {
        if (entry.kind !== 'stmt' || entry.stmt.kind !== 'evaluate' || entry.stmt.expr.kind !== 'call')
            continue;
        const path = pathOf(entry.stmt.expr.callee);
        if (path === 'indicator' || path === 'strategy' || path === 'library') {
            return { stmt: entry.stmt, call: entry.stmt.expr, path };
        }
    }
    return undefined;
}
export function importScript(text, options = {}) {
    const file = sourceFile(options.name ?? 'imported', text);
    const items = readItems(file);
    const annotation = annotationOf(items);
    if (annotation === undefined || (annotation.version !== '5' && annotation.version !== '6')) {
        const at = annotation === undefined ? file.spanAt(0, 0) : file.spanAt(annotation.remark.offset, annotation.remark.text.length + 2);
        const found = annotation === undefined ? 'declares no version' : `declares version ${annotation.version}`;
        return refusal(diagnosticFor('OS9001', at, { found }));
    }
    const body = readScript(items);
    const declaration = declarationOf(body);
    if (declaration === undefined)
        return refusal(diagnosticFor('OS9004', firstStatement(file, body), { found: 'has none' }));
    if (declaration.path === 'library') {
        return refusal(diagnosticFor('OS9004', file.spanAt(declaration.call.callee.at.offset, declaration.call.callee.at.length), { found: 'declares a library' }));
    }
    const used = new Set();
    for (const item of items) {
        if (item.kind !== 'code')
            continue;
        for (const token of item.logical.tokens)
            if (token.kind === 'name')
                used.add(token.text);
    }
    const version = annotation.version === '5' ? 5 : 6;
    const globals = new Set();
    for (const entry of body)
        if (entry.kind === 'stmt')
            for (const one of declaresOf(entry.stmt))
                globals.add(one.name);
    const ctx = new Context({ file, version, used, globals, reassigned: reassignments(body), entries: entrySides(body) });
    const declared = nodeOf(declaration.stmt, true);
    ctx.node = declared;
    const trailing = declaration.stmt.remarks.map((one) => `  //${one.text}`).join('');
    declared.output = [{ depth: 0, text: `${declarationLine(ctx, declaration.call, declaration.path)}${trailing}` }];
    ctx.node = undefined;
    const nodes = [declared];
    const pieces = [];
    const later = [];
    let stage = 'before';
    for (const entry of body) {
        if (entry.kind === 'remark' && entry.remark === annotation.remark) {
            pieces.push({ kind: 'text', text: 'version 1' }, { kind: 'blank' });
            stage = 'header';
            continue;
        }
        if (entry.kind === 'stmt' && entry.stmt === declaration.stmt) {
            pieces.push({ kind: 'node', node: declared }, ...later);
            later.length = 0;
            stage = 'body';
            continue;
        }
        const piece = entry.kind === 'remark'
            ? { kind: 'remark', remark: entry.remark, depth: 0 }
            : entry.kind === 'blank'
                ? { kind: 'blank' }
                : undefined;
        if (piece !== undefined) {
            pieces.push(piece);
            continue;
        }
        if (entry.kind !== 'stmt')
            continue;
        const node = nodeOf(entry.stmt, false);
        ctx.node = node;
        node.output = translateStatement(ctx, entry.stmt, 0);
        for (const one of node.declares) {
            if (!ctx.fileScope.names.has(one.name)) {
                ctx.fileScope.names.set(one.name, binding(ctx.namer.declare(one.name, false), 'variable', true));
            }
        }
        ctx.node = undefined;
        nodes.push(node);
        if (stage === 'body')
            pieces.push({ kind: 'node', node });
        else
            later.push({ kind: 'node', node });
    }
    const source = settle(ctx, nodes, pieces);
    return { source, findings: findingsOf(nodes) };
}
//# sourceMappingURL=importer.js.map