import { makeNode } from '../ast/index.js';
import { RESERVED_WORDS } from '../tokens/index.js';
import { describeToken } from './cursor.js';
/**
 * Reading the places a name is written, which is where OS1019 lives.
 *
 * The lexer cannot make this call. A reserved word before an `=` is a legal
 * label inside a call and is OS1019 inside a parameter list (language.md 3.4),
 * and only the parser knows which of the two lists it is reading. So a reserved
 * word arrives carrying its keyword kind, and the readers below are the
 * answers: `takeName` refuses one, `takeLabel` and `takeMember` accept one,
 * because a label and a member are matched against a published list rather than
 * looked up in a scope.
 */
const RESERVED = new Set(RESERVED_WORDS);
/** Whether a token may stand where a word is expected. */
export function isWordKind(kind) {
    return kind === 'identifier' || RESERVED.has(kind);
}
/**
 * The reserved words a reader can only have meant as a name.
 *
 * A reserved word written where a value belongs is one of two things, and which
 * one depends on the word. Six of them are read by a rule standing next to the
 * expression: `and` and `or` join two operands and `not` takes one, and `in`,
 * `to` and `step` are read by a `for` header the moment the expression before
 * them ends. A word that opens a statement is the same answer again, because an
 * unclosed bracket carries the statement onto the lines below it and the `if`
 * down there belongs to its own line rather than to this expression. Taking any
 * of those as a name would swallow a token the rule around it is waiting for,
 * and the second diagnostic would then be about the rule rather than about the
 * mistake.
 *
 * What is left is the four value type names, the two words that build a type,
 * and the six the language reserves and version 1 does not implement. No rule
 * of the grammar reads one of them anywhere near an expression, so a reader who
 * wrote one where a value belongs wrote a name, and the answer is OS1019: the
 * same answer `takeName` gives for the same word written as a target.
 */
const MEANT_AS_A_NAME = new Set([
    'array',
    'as',
    'bool',
    'color',
    'import',
    'is',
    'map',
    'matrix',
    'number',
    'series',
    'string',
    'type',
]);
/** Whether a word standing where a value belongs is a name the language has taken. */
export function isMeantAsAName(kind) {
    return MEANT_AS_A_NAME.has(kind);
}
/**
 * A name that is not reserved, derived from one that is.
 *
 * OS1019 promises a near name that keeps the meaning, and the derivation has to
 * work for all thirty six words rather than for the five anyone remembers, so
 * it is mechanical: the word is what the reader meant, and the suffix is what
 * makes it theirs to use.
 */
function unreservedNear(word) {
    return `${word}Value`;
}
/**
 * The library spelling of a reserved word somebody wrote as a call.
 *
 * `bool` and `number` name types, and the two conversions to those types have to
 * be called by a name, which a reserved word is not. For one release the library
 * published them under the type names anyway: the checker called them functions,
 * the lexer called the same words reserved, and every spelling a reader could
 * write was refused with advice to rename a variable they had not declared. The
 * conversions are `toBool` and `toNumber`, and this is the table that says so to
 * whoever wrote the natural thing.
 *
 * It is two entries because two names collided, not because a rule needs a list:
 * a library name is never a reserved word, and `tests/unit/library-names.test.ts`
 * fails the build if one ever is again.
 */
const CALLED_INSTEAD = new Map([
    ['bool', 'toBool'],
    ['number', 'toNumber'],
]);
/** No word where one was required, which leaves the statement without its subject. */
function missingWord(cursor) {
    const hole = cursor.holeSpan();
    cursor.report('OS1022', hole, {
        token: describeToken(cursor.previousMeaningful() ?? cursor.token),
    });
    return makeNode('name', hole, { text: '' });
}
/**
 * The name at the cursor: an identifier, or a reserved word that is OS1019.
 *
 * The word is taken either way. A script that named something `type` still
 * meant to declare it, and every later diagnostic about that name is more use
 * to the reader than a hole where the declaration should have been.
 *
 * `asValue` is set by the one reader that takes a word from where a value
 * belongs, and it is what lets the fix be true of the program in front of it. A
 * word with an argument list after it is a call, and a reader who wrote one
 * wants the name the library really publishes; the same word being declared or
 * assigned to wants a name of their own, and the library's would collide.
 */
export function takeName(cursor, asValue = false) {
    const token = cursor.token;
    if (!isWordKind(token.kind))
        return missingWord(cursor);
    cursor.advance();
    if (token.kind !== 'identifier') {
        const called = asValue && cursor.kind === '(' ? CALLED_INSTEAD.get(token.text) : undefined;
        cursor.report('OS1019', token.span, {
            word: token.text,
            suggestion: called ?? unreservedNear(token.text),
        });
    }
    return makeNode('name', token.span, { text: token.text });
}
/**
 * The label of a named argument, where a reserved word is legal.
 *
 * A label is matched against the callee's parameter list and is never looked up
 * in a scope, so `plot(v, "V", color = aqua)` is correct and is not OS1019.
 */
export function takeLabel(cursor) {
    const token = cursor.advance();
    return makeNode('name', token.span, { text: token.text });
}
/**
 * The word after a dot.
 *
 * A member is matched against the namespace or the object type it was read
 * from, which is the same kind of published list a label is matched against, so
 * a reserved word is not OS1019 here either. Whether the member exists at all
 * is OS2009, and the checker owns it.
 */
export function takeMember(cursor) {
    return isWordKind(cursor.kind) ? takeLabel(cursor) : missingWord(cursor);
}
/** Whether the cursor is on a named argument's label: a word, then a bare `=`. */
export function atLabel(cursor) {
    return isWordKind(cursor.kind) && cursor.peek().kind === '=';
}
//# sourceMappingURL=names.js.map