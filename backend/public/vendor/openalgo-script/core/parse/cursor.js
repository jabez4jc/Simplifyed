import { endOffset } from '../span/index.js';
/**
 * The parser's place in the token stream, and the three things every rule of
 * the grammar needs that are not grammar: where it is, how it reports, and how
 * it gets out of trouble.
 *
 * Recovery lives here rather than in each rule because it has to be the same
 * everywhere. A trader with three mistakes in a file wants three diagnostics,
 * so no rule throws and no rule gives up on the file: it reports, skips to the
 * next boundary the language guarantees, and carries on. The boundaries are the
 * lexer's own layout tokens, which is what makes the skip reliable rather than
 * a guess: a statement ends at a `newline`, and a block is bracketed by an
 * `indent` and a `dedent`.
 */
/**
 * The ceiling on source nesting, OS5005.
 *
 * Its purpose is a bounded stack: the parser descends one frame per level of
 * brackets, and generated source is the usual way a file reaches a depth no
 * person writes. The specification names no number, so this one is the
 * compiler's, and it is far above anything written by hand: the deepest
 * expression in the example scripts nests four.
 */
const MAX_NESTING = 128;
/** The tokens that end a statement. None of them is ever part of one. */
const STATEMENT_END = new Set([
    'newline',
    'dedent',
    'endOfFile',
]);
const LAYOUT = new Set([
    'newline',
    'indent',
    'dedent',
    'endOfFile',
]);
/**
 * What a diagnostic calls a token when it has to quote one.
 *
 * A layout token carries no text, and a message that quoted one would quote
 * nothing at all, so each is named by what a reader would call it.
 */
export function describeToken(token) {
    switch (token.kind) {
        case 'newline':
            return 'the end of the line';
        case 'endOfFile':
            return 'the end of the file';
        case 'indent':
        case 'dedent':
            return 'the change of indentation';
        default:
            return token.text;
    }
}
export class Cursor {
    file;
    #tokens;
    #sink;
    #at = 0;
    /** Diagnostics reported since this statement began. See `reportedHere`. */
    #reported = 0;
    #expressions = 0;
    #blocks = 0;
    #abandoned = false;
    #firstStatementLine;
    #ifColumn;
    #loops = 0;
    constructor(file, tokens, sink) {
        this.file = file;
        this.#tokens = tokens;
        this.#sink = sink;
    }
    // ---------------------------------------------------------------------------
    // Where it is
    // ---------------------------------------------------------------------------
    /** An index into the stream, which a loop compares to prove it made progress. */
    get position() {
        return this.#at;
    }
    get token() {
        return this.#tokenAt(this.#at);
    }
    get kind() {
        return this.token.kind;
    }
    peek(ahead = 1) {
        return this.#tokenAt(this.#at + ahead);
    }
    at(kind) {
        return this.token.kind === kind;
    }
    atStatementEnd() {
        return STATEMENT_END.has(this.token.kind);
    }
    advance() {
        const token = this.token;
        if (this.#at < this.#tokens.length - 1)
            this.#at += 1;
        return token;
    }
    take(kind) {
        return this.at(kind) ? this.advance() : undefined;
    }
    /** The last token consumed, for a node that has to end where one ended. */
    previous() {
        return this.#tokenAt(this.#at - 1);
    }
    /**
     * The token before this one, when it is one a reader wrote.
     *
     * OS1022 names the token the statement ran out after, which is the one to the
     * left of the hole. At the start of a line there is no such token, and the
     * caller names the one it is looking at instead.
     */
    previousMeaningful() {
        const before = this.#tokenAt(this.#at - 1);
        return this.#at > 0 && !LAYOUT.has(before.kind) ? before : undefined;
    }
    /**
     * What the reader wrote across a span.
     *
     * A diagnostic that has to quote a piece of a program quotes the source
     * rather than rebuilding it from the tree. `a.b` put back together out of a
     * member node is a reconstruction, and one that differs from the page by so
     * much as a space sends the reader looking for something they did not write.
     */
    textOf(span) {
        return this.file.text.slice(span.offset, endOffset(span));
    }
    /** An empty span where something should have been written and was not. */
    holeSpan() {
        return this.file.spanAt(this.token.span.offset, 0);
    }
    #tokenAt(index) {
        const clamped = Math.min(Math.max(index, 0), this.#tokens.length - 1);
        // The stream always ends with an end of file token, so there is no empty
        // case here to invent a token for.
        return this.#tokens[clamped];
    }
    // ---------------------------------------------------------------------------
    // How it reports
    // ---------------------------------------------------------------------------
    report(code, span, values) {
        // An abandoned statement has said what it has to say. Everything an
        // unwinding parser would report after it is about the same mistake, and a
        // file that reports two hundred unclosed brackets for one expression that
        // was too deep has told the reader nothing.
        if (this.#abandoned)
            return;
        this.#reported += 1;
        this.#sink.report(code, span, values);
    }
    /**
     * Whether this statement has already been reported on.
     *
     * One mistake is one diagnostic. A statement that has been reported on has
     * nothing more to say about its own leftovers, so the second message about
     * the same mistake is suppressed rather than the reader being left to work
     * out which of the two to believe.
     */
    get reportedHere() {
        return this.#reported > 0;
    }
    /**
     * A token where the grammar had one exact thing in mind, OS1018.
     *
     * The catalogue has no code for "a closing bracket belongs here", so the one
     * it does have is used for all of them: OS1018 states what is true, that the
     * token was not expected where it sits, and its fix names the two things that
     * are usually wrong, a missing operator or a line that lost its newline.
     */
    unexpected(token) {
        this.report('OS1018', token.span, { token: describeToken(token) });
    }
    /**
     * Whether one more level of expression nesting is within the ceiling.
     *
     * Refusing abandons the statement rather than only this level, because a
     * parser that unwound from here would report the brackets it never reached
     * the closers of, one per level, all of them about the expression that was
     * already too deep.
     */
    deeper(span) {
        if (this.#expressions >= MAX_NESTING) {
            this.report('OS5005', span, {
                construct: 'An expression',
                found: this.#expressions + 1,
                max: MAX_NESTING,
            });
            this.#abandoned = true;
            return false;
        }
        this.#expressions += 1;
        return true;
    }
    shallower() {
        this.#expressions -= 1;
    }
    /**
     * The same ceiling for blocks, counted across statements rather than within
     * one, because a block's depth is the file's shape and not a line's.
     *
     * A refusal here costs the block and not the statement: the caller skips the
     * whole of it, so there is nothing left inside to report on twice.
     */
    openBlock(span) {
        if (this.#blocks >= MAX_NESTING) {
            this.report('OS5005', span, {
                construct: 'A block',
                found: this.#blocks + 1,
                max: MAX_NESTING,
            });
            return false;
        }
        this.#blocks += 1;
        return true;
    }
    closeBlock() {
        this.#blocks -= 1;
    }
    // ---------------------------------------------------------------------------
    // The file as a whole
    // ---------------------------------------------------------------------------
    beginStatement() {
        this.#reported = 0;
        this.#expressions = 0;
        this.#abandoned = false;
    }
    /**
     * The first statement in the file, which is the line OS1021 names when a
     * version declaration turns up below it.
     */
    noteStatement(line) {
        this.#firstStatementLine ??= line;
    }
    get firstStatementLine() {
        return this.#firstStatementLine;
    }
    /** Where the most recent `if` sat, which is what OS1016 pairs an `else` against. */
    noteIf(column) {
        this.#ifColumn = column;
    }
    get nearestIfColumn() {
        return this.#ifColumn ?? 1;
    }
    /**
     * Whether a loop body is being read, which is the whole of OS1009.
     *
     * It is a count on the cursor rather than an argument threaded through every
     * rule, because the one question `break` asks is whether any loop is open,
     * and a function body cannot be inside one: functions are top level only.
     */
    enterLoop() {
        this.#loops += 1;
    }
    leaveLoop() {
        this.#loops -= 1;
    }
    get insideLoop() {
        return this.#loops > 0;
    }
    // ---------------------------------------------------------------------------
    // How it gets out of trouble
    // ---------------------------------------------------------------------------
    /** To the end of this line, taking the newline, and no further. */
    skipToEndOfLine() {
        const before = this.#at;
        while (!this.atStatementEnd())
            this.advance();
        if (this.take('newline') !== undefined)
            return;
        // A skip that consumed nothing leaves the loop that called it where it
        // began, and a compiler that hangs on a malformed file is worse than one
        // that gives up on it.
        if (this.#at === before && !this.at('endOfFile'))
            this.advance();
    }
    /**
     * The whole statement, including a block written under it.
     *
     * This is the boundary to recover at when the line itself was not understood.
     * A header the parser could not read still has its body indented beneath it,
     * and reading that body as though it stood at the outer level would report
     * every line of it.
     */
    skipStatement() {
        this.skipToEndOfLine();
        this.skipBlockBody();
    }
    /** A block, and the blocks inside it, when no statement can hold it. */
    skipBlockBody() {
        if (!this.at('indent'))
            return;
        let depth = 0;
        do {
            if (this.at('indent'))
                depth += 1;
            else if (this.at('dedent'))
                depth -= 1;
            this.advance();
        } while (depth > 0 && !this.at('endOfFile'));
    }
}
//# sourceMappingURL=cursor.js.map