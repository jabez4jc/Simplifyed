import { ASSIGNMENT_OPERATORS, makeNode, withoutGrouping } from '../ast/index.js';
import { spanning } from '../span/index.js';
import { parseTypeAnnotation } from './annotations.js';
import { parseIfStatement } from './branches.js';
import { missingExpression, parseArgumentList, parseExpression } from './expressions.js';
import { parseFunctionDeclaration } from './functions.js';
import { parseForStatement, parseWhileStatement } from './loops.js';
import { isWordKind, takeName } from './names.js';
import { parseSwitchStatement } from './switches.js';
/**
 * One statement, and the choice of which one it is.
 *
 * The choice is made from the first token and at most one more, which is what
 * keeps the language readable: a line that begins with `if` is an `if` and
 * nothing else, and the only lookahead anywhere is the token after a word,
 * which says whether the word is being assigned to.
 *
 * Three of the forms here describe the file rather than compute anything. They
 * are statements like the rest and may be written anywhere a statement may be,
 * because the errors for putting one in the wrong place name a line and suggest
 * a move (OS1021, OS2007, OS2008, OS3014), and a tree that refused to hold them
 * could not carry a line number for any of those to report.
 */
const ASSIGNMENT = new Set(ASSIGNMENT_OPERATORS);
export function parseStatement(cursor) {
    cursor.beginStatement();
    const statement = dispatch(cursor);
    if (statement !== undefined)
        cursor.noteStatement(statement.span.line);
    return statement;
}
/**
 * The end of a statement: a newline, and OS1018 for anything before it.
 *
 * A line holds at most one statement, so whatever is left over is either a
 * missing operator or a second statement that lost its newline. It is only
 * reported when the statement has nothing else wrong with it, because leftovers
 * are what every other mistake on the line produces and the reader should be
 * told about the mistake rather than about its wreckage.
 */
export function finishStatement(cursor) {
    if (cursor.take('newline') !== undefined)
        return;
    if (cursor.atStatementEnd())
        return;
    if (!cursor.reportedHere)
        cursor.unexpected(cursor.token);
    cursor.skipToEndOfLine();
}
function dispatch(cursor) {
    switch (cursor.kind) {
        case 'if':
            return parseIfStatement(cursor);
        case 'for':
            return parseForStatement(cursor);
        case 'while':
            return parseWhileStatement(cursor);
        case 'switch':
            return parseSwitchStatement(cursor);
        case 'break':
        case 'continue':
            return parseJump(cursor);
        case 'return':
            return parseReturn(cursor);
        case 'var':
            return parseVarDeclaration(cursor, false);
        case 'live':
            return cursor.peek().kind === 'var'
                ? parseVarDeclaration(cursor, true)
                : parseSimpleStatement(cursor);
        case 'study':
        case 'strategy':
            return parseScriptDeclaration(cursor);
        case 'else':
            return strayElse(cursor);
        case 'case':
        case 'default':
            return strayArm(cursor);
        case 'fn':
            return nestedFunction(cursor);
        default:
            return parseSimpleStatement(cursor);
    }
}
function parseSimpleStatement(cursor) {
    const token = cursor.token;
    // A block whose header was not understood, so nothing is left that could own
    // it. Skipping it whole reports the header once instead of every line of it.
    if (token.kind === 'indent') {
        cursor.skipBlockBody();
        return undefined;
    }
    if (token.kind === 'identifier') {
        const next = cursor.peek();
        // `version` and `limits` are not reserved words: a script written before
        // either existed keeps compiling, so both are recognised by position.
        if (token.text === 'version' && next.kind === 'numberLiteral') {
            return parseVersionLine(cursor, next);
        }
        if (token.text === 'limits' && next.kind === '(')
            return parseLimitsLine(cursor);
    }
    if (isWordKind(token.kind) && ASSIGNMENT.has(cursor.peek().kind)) {
        return parseAssignment(cursor);
    }
    if (cursor.atStatementEnd()) {
        cursor.take('newline');
        return undefined;
    }
    const expression = parseExpression(cursor);
    if (ASSIGNMENT.has(cursor.kind)) {
        const refused = assignmentToSomethingOtherThanAName(cursor, expression);
        if (refused !== undefined)
            return refused;
    }
    finishStatement(cursor);
    return makeNode('expressionStatement', expression.span, { expression });
}
/**
 * An assignment whose target is an index or a member: OS1024 and OS1025.
 *
 * The grammar of section 19 has one assignment target and it is an identifier,
 * so what is wrong on this line is the target and not the operator after it.
 * That is why neither of these is OS1018, whose message would say the statement
 * had ended before an operator the reader wrote in the middle of it. Two codes
 * rather than one because the two have different fixes: an array element is
 * written with a call, and a member is not written at all.
 *
 * Anything else the grammar cannot assign to, a literal or a call, is left to
 * the caller and reported as OS1018, which is the nearest true thing the
 * catalogue has for it.
 *
 * The value is read rather than skipped, so a mistake in it is reported on the
 * same compile, and the statement reaches the tree as the target that was
 * written. There is no node for an assignment whose target is not a name, and
 * building one over a name taken out of the target, `prices` out of
 * `prices[0]`, would put a different program in the tree from the one on the
 * page.
 */
function assignmentToSomethingOtherThanAName(cursor, target) {
    const written = withoutGrouping(target);
    if (written.kind === 'index') {
        cursor.report('OS1024', target.span, { name: cursor.textOf(written.target.span) });
    }
    else if (written.kind === 'member') {
        cursor.report('OS1025', target.span, {
            name: cursor.textOf(written.object.span),
            member: written.member.text,
        });
    }
    else {
        return undefined;
    }
    // The operator, and then the value, which is read so that a mistake inside it
    // is reported on this compile rather than on the one after the target is
    // fixed.
    cursor.advance();
    const value = parseExpression(cursor);
    finishStatement(cursor);
    return makeNode('expressionStatement', spanning(target.span, value.span), {
        expression: target,
    });
}
function parseAssignment(cursor) {
    const target = takeName(cursor);
    const operator = cursor.advance().kind;
    const value = parseExpression(cursor);
    finishStatement(cursor);
    return makeNode('assignment', spanning(target.span, value.span), { target, operator, value });
}
function parseVarDeclaration(cursor, live) {
    const start = cursor.advance();
    if (live)
        cursor.advance();
    const name = takeName(cursor);
    const annotation = cursor.take(':') !== undefined ? parseTypeAnnotation(cursor) : undefined;
    let initialiser;
    if (cursor.take('=') !== undefined) {
        initialiser = parseExpression(cursor);
    }
    else {
        // The declaration and the first assignment are one statement, so a
        // persistent value always has something in it and no bar can read it
        // before it exists.
        cursor.report('OS1011', spanning(start.span, name.span), { name: name.text });
        initialiser = missingExpression(cursor);
    }
    finishStatement(cursor);
    return makeNode('varDeclaration', spanning(start.span, initialiser.span), {
        live,
        name,
        annotation,
        initialiser,
    });
}
function parseScriptDeclaration(cursor) {
    const keyword = cursor.advance();
    const open = cursor.take('(');
    const list = open === undefined ? undefined : parseArgumentList(cursor, open);
    finishStatement(cursor);
    return makeNode('scriptDeclaration', spanning(keyword.span, list?.end ?? keyword.span), {
        form: keyword.kind === 'study' ? 'study' : 'strategy',
        args: list?.items ?? [],
    });
}
function parseVersionLine(cursor, number) {
    const word = cursor.advance();
    cursor.advance();
    const span = spanning(word.span, number.span);
    const before = cursor.firstStatementLine;
    if (before !== undefined)
        cursor.report('OS1021', span, { line: before });
    finishStatement(cursor);
    return makeNode('versionLine', span, {
        version: makeNode('numberLiteral', number.span, { value: number.value }),
    });
}
function parseLimitsLine(cursor) {
    const word = cursor.advance();
    const list = parseArgumentList(cursor, cursor.advance());
    finishStatement(cursor);
    return makeNode('limitsLine', spanning(word.span, list.end), { args: list.items });
}
function parseJump(cursor) {
    const keyword = cursor.advance();
    if (!cursor.insideLoop)
        cursor.report('OS1009', keyword.span, { word: keyword.text });
    finishStatement(cursor);
    return keyword.kind === 'break'
        ? makeNode('breakStatement', keyword.span, {})
        : makeNode('continueStatement', keyword.span, {});
}
function parseReturn(cursor) {
    const keyword = cursor.advance();
    // A bare `return` exits with `none`, so the value is genuinely absent here
    // rather than a hole something went missing from.
    const value = cursor.atStatementEnd() ? undefined : parseExpression(cursor);
    finishStatement(cursor);
    return makeNode('returnStatement', value === undefined ? keyword.span : spanning(keyword.span, value.span), { value });
}
/**
 * An `else` that no `if` took.
 *
 * `parseIfStatement` takes the `else` that belongs to it, so one that reaches
 * here has no `if` at its own indentation: either the statement above it is
 * something else, or the lexer has already put the two in different blocks.
 */
function strayElse(cursor) {
    const token = cursor.token;
    cursor.report('OS1016', token.span, {
        found: token.span.column - 1,
        expected: cursor.nearestIfColumn - 1,
    });
    cursor.skipStatement();
    return undefined;
}
function strayArm(cursor) {
    const token = cursor.token;
    cursor.report('OS1017', token.span, { word: token.text });
    cursor.skipStatement();
    return undefined;
}
/**
 * A `fn` inside a block, which language.md 11.1 forbids: OS1023.
 *
 * It is read and it is kept. Reading it keeps the lines under it from being
 * taken for statements of the block around it. Keeping it is what lets anything
 * after the parser see the function at all: a declaration dropped here is gone
 * from the tree, so a call to it could only ever be reported as a name nobody
 * declared, and a nested function nobody calls would go unreported for good. It
 * stays where the reader wrote it rather than being lifted to the top level,
 * which would compile a file the language refuses.
 *
 * The caret covers `fn` and the name, which is the part of the declaration the
 * reader has to move, and the same span OS1011 puts under `var name`.
 *
 * A header with no name at all has already been told that a name was expected,
 * and the message here has nothing to name, so it waits: the node is kept
 * either way, and the declaration is reported as nested once it has a name for
 * the sentence to use and for the fix to tell the reader to call.
 */
function nestedFunction(cursor) {
    const keyword = cursor.token;
    const declaration = parseFunctionDeclaration(cursor);
    if (declaration.name.text !== '') {
        cursor.report('OS1023', spanning(keyword.span, declaration.name.span), {
            name: declaration.name.text,
        });
    }
    return declaration;
}
//# sourceMappingURL=statements.js.map