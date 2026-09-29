import { PUNCTUATORS, RESERVED_WORDS } from '../tokens/index.js';
import { APOSTROPHE, BACKSLASH, DOT, HASH, isBlank, isDigit, isNamePart, isNameStart, LINE_FEED, QUOTE, SEMICOLON, SLASH, SPACE, TAB, } from './characters.js';
import { closesComment, commentRegion, hasCloser, opensComment } from './comments.js';
import { Layout } from './layout.js';
import { scanNumber } from './numbers.js';
import { continuesLine } from './statements.js';
import { scanString } from './strings.js';
import { describeUnexpected, isNonAsciiLetter } from './unexpected.js';
const RESERVED = new Set(RESERVED_WORDS);
const ONE_CHARACTER = new Set(PUNCTUATORS.filter((mark) => mark.length === 1));
const TWO_CHARACTER = new Set(PUNCTUATORS.filter((mark) => mark.length === 2));
/**
 * The two character operators of other languages, which this one does not have
 * (3.12). They are matched as a pair so that the message names the operator the
 * reader wrote and offers the one to write instead, rather than reporting one
 * ampersand and leaving them to work out which half was wrong.
 */
const REJECTED_PAIRS = new Set(['&&', '||', '**', '++']);
const OPENING_BRACKETS = new Set(['(', '[']);
const CLOSING_BRACKETS = new Set([')', ']']);
const HEX_ONLY = /^[0-9a-fA-F]+$/;
class Lexer {
    #file;
    #text;
    #sink;
    #tokens = [];
    #layout;
    #offset = 0;
    #line = 1;
    #indent = 0;
    #brackets = 0;
    #continuing = false;
    #lineHasToken = false;
    #droppedAfterToken = false;
    /** Whether a block comment marker opened a region that no closer has ended yet. */
    #inComment = false;
    constructor(file, sink) {
        this.#file = file;
        this.#text = file.text;
        this.#sink = sink;
        this.#layout = new Layout(file, sink, this.#tokens);
    }
    run() {
        while (this.#offset < this.#text.length)
            this.#readLine();
        this.#finish();
        return this.#tokens;
    }
    // -------------------------------------------------------------------------
    // Lines
    // -------------------------------------------------------------------------
    #readLine() {
        const start = this.#offset;
        let i = start;
        // A tab is one character of indentation here, and OS1002 as soon as the line
        // turns out to carry a token. It is counted rather than expanded because the
        // report is what matters and a width would be a guess at an editor setting.
        let hasTab = false;
        while (isBlank(this.#text.charCodeAt(i))) {
            if (this.#text.charCodeAt(i) === TAB)
                hasTab = true;
            i++;
        }
        this.#indent = i - start;
        this.#layout.beginLine(this.#line, start, this.#indent, this.#text.slice(start, i), hasTab);
        this.#offset = i;
        this.#lineHasToken = false;
        this.#droppedAfterToken = false;
        if (this.#inComment)
            this.#skipComment(this.#offset);
        let backslash = false;
        while (this.#offset < this.#text.length) {
            const code = this.#text.charCodeAt(this.#offset);
            if (code === LINE_FEED)
                break;
            if (code === SPACE) {
                this.#offset++;
                continue;
            }
            if (code === SLASH && this.#text.charCodeAt(this.#offset + 1) === SLASH) {
                // A comment produces no token, which is what lets a commented out line
                // sit at column zero inside a block without closing it (3.10).
                this.#offset = this.#endOfLine(this.#offset);
                break;
            }
            if (opensComment(this.#text, this.#offset)) {
                this.#openComment();
                continue;
            }
            if (closesComment(this.#text, this.#offset)) {
                // A closer with nothing open. The region it was meant to end was never
                // read as one, so the marker is reported where it sits and read as
                // nothing at all.
                this.#sink.report('OS1026', this.#span(this.#offset, 2), { marker: '*/' });
                this.#offset += 2;
                continue;
            }
            if (code === BACKSLASH && this.#isBlankTo(this.#offset + 1)) {
                backslash = true;
                this.#offset = this.#endOfLine(this.#offset);
                break;
            }
            this.#readToken();
        }
        this.#endLine(backslash);
    }
    #endLine(backslash) {
        // A line carrying no token says nothing about the statement around it, so a
        // blank line and a comment-only line inside a continuation leave it open
        // (3.11) by never being asked.
        if (this.#lineHasToken || backslash) {
            // A trailing operator whose operand was rejected promised nothing: the
            // operand was written, it was just not written in this language. Letting
            // it continue would hand the next line to a broken statement, and one bad
            // character would take a line that has nothing wrong with it.
            const promised = !this.#droppedAfterToken && continuesLine(this.#tokens);
            this.#continuing = this.#brackets > 0 || backslash || promised;
        }
        if (this.#lineHasToken && !this.#continuing) {
            this.#layout.endStatement();
            const atEnd = this.#offset >= this.#text.length;
            this.#emitNewline(this.#span(this.#offset, atEnd ? 0 : 1));
        }
        if (this.#offset < this.#text.length) {
            this.#offset++;
            this.#line++;
        }
        this.#layout.endLine();
    }
    #finish() {
        const last = this.#tokens[this.#tokens.length - 1];
        if (last !== undefined && last.kind !== 'newline') {
            // A bracket that is never closed reads the rest of the file as one
            // statement (3.11), and that statement still has to end somewhere for the
            // parser to report it against.
            this.#layout.endStatement();
            this.#emitNewline(this.#span(this.#text.length, 0));
        }
        this.#layout.closeBlocks(this.#text.length);
        this.#tokens.push({ kind: 'endOfFile', span: this.#span(this.#text.length, 0), text: '' });
    }
    /**
     * A region the writer meant as a comment, from its opener to its closer.
     *
     * It is reported once, at the opener, and then skipped. Reading the prose
     * inside it as tokens would report the operators it happens to contain and
     * the statements it appears to hold, which is several diagnostics about a
     * program the writer did not write, and none of them would name the comment
     * (3.2).
     */
    #openComment() {
        this.#sink.report('OS1026', this.#span(this.#offset, 2), { marker: '/*' });
        this.#skipComment(this.#offset + 2);
        // A closer written nowhere makes no region: the marker costs this line and
        // the file is read on from the next one, rather than being swallowed whole
        // by a form the language does not have (3.2).
        this.#inComment = this.#inComment && hasCloser(this.#text, this.#offset);
    }
    /**
     * The region, to its closer or to the end of the line, said once and then
     * skipped: one region is one mistake however many lines it runs to, so a
     * line below the opener is read as prose rather than reported again.
     */
    #skipComment(from) {
        const region = commentRegion(this.#text, from);
        this.#inComment = region.open;
        this.#offset = region.end;
    }
    #endOfLine(from) {
        const at = this.#text.indexOf('\n', from);
        return at === -1 ? this.#text.length : at;
    }
    #isBlankTo(from) {
        for (let i = from; i < this.#text.length; i++) {
            const code = this.#text.charCodeAt(i);
            if (code === LINE_FEED)
                return true;
            if (!isBlank(code))
                return false;
        }
        return true;
    }
    // -------------------------------------------------------------------------
    // Tokens
    // -------------------------------------------------------------------------
    #readToken() {
        const start = this.#offset;
        const code = this.#text.charCodeAt(start);
        if (isNameStart(code)) {
            this.#readName(start);
            return;
        }
        if (isDigit(code) || (code === DOT && isDigit(this.#text.charCodeAt(start + 1)))) {
            this.#readNumber(start);
            return;
        }
        if (code === QUOTE || code === APOSTROPHE) {
            this.#readString(start);
            return;
        }
        if (code === HASH) {
            this.#readColour(start);
            return;
        }
        if (code === SEMICOLON) {
            this.#readSemicolon(start);
            return;
        }
        this.#readPunctuation(start);
    }
    /**
     * A name, and with it every reserved word, which is spelled like one and told
     * apart by the table rather than by the scanner.
     *
     * A reserved word keeps its own kind here even where the parser will accept it
     * as a named argument label (3.4). The lexer cannot make that call: the same
     * word before an `=` is a legal label inside a call and is OS1019 inside a
     * parameter list, and only the parser knows which of the two it is reading.
     */
    #readName(start) {
        const word = this.#word(start);
        if (word.foreign !== undefined) {
            // Identifiers are ASCII (3.3). The whole word is taken as one name so that
            // the statement around it still parses and one bad character reports once.
            this.#sink.report('OS1001', this.#span(word.foreign.offset, word.foreign.written.length), describeUnexpected(word.foreign.written));
        }
        const text = this.#text.slice(start, word.end);
        const kind = RESERVED.has(text) ? text : 'identifier';
        this.#emit({ kind, span: this.#span(start, word.end - start), text });
        this.#offset = word.end;
    }
    /**
     * A number literal, and the run that is not one: a base prefix the language
     * does not have, a unit written against a quantity, a literal that ends in an
     * underscore (3.5).
     *
     * Such a run is reported whole, as OS1029. Every character in it is one the
     * language accepts, so naming the leading digit would name something legal,
     * and deleting it, which is what OS1001 tells a reader to do with the
     * character it names, leaves a valid name behind and a program that compiles
     * and means something else.
     */
    #readNumber(start) {
        const literal = scanNumber(this.#text, start);
        const after = this.#text.codePointAt(literal.end);
        if (after !== undefined && (isNamePart(after) || isNonAsciiLetter(after))) {
            // A name cannot begin with a digit (3.3), and a letter written against a
            // number is that mistake rather than two tokens that happen to touch.
            const word = this.#word(literal.end);
            const written = this.#text.slice(start, word.end);
            this.#sink.report('OS1029', this.#span(start, word.end - start), {
                written,
                number: this.#text.slice(start, literal.end),
            });
            this.#emit({
                kind: 'identifier',
                span: this.#span(start, word.end - start),
                text: written,
            });
            this.#offset = word.end;
            return;
        }
        this.#emit({
            kind: 'numberLiteral',
            span: this.#span(start, literal.end - start),
            text: this.#text.slice(start, literal.end),
            value: literal.value,
        });
        this.#offset = literal.end;
    }
    #readString(start) {
        const literal = scanString(this.#text, start);
        for (const bad of literal.badEscapes) {
            this.#sink.report('OS1005', this.#span(bad.offset, bad.length), { sequence: bad.text });
        }
        if (literal.unterminated) {
            this.#sink.report('OS1004', this.#span(start, 1), { quote: this.#text.charAt(start) });
        }
        // The token is emitted either way. The reader is told once that the quote is
        // missing; they do not also need to be told that the statement around it
        // makes no sense without it.
        this.#emit({
            kind: 'stringLiteral',
            span: this.#span(start, literal.end - start),
            text: this.#text.slice(start, literal.end),
            value: literal.value,
        });
        this.#offset = literal.end;
    }
    /**
     * `#rrggbb` and `#rrggbbaa` (3.8).
     *
     * A run of the wrong length, or one carrying a character that is not a
     * hexadecimal digit, is a colour the writer had nearly right, and it is
     * OS1027 over the whole of what they wrote. The OS1001 sentence about `#`
     * says to delete the character or to put the text in a string, which is the
     * answer for a `#` standing on its own and would throw the colour away here.
     */
    #readColour(start) {
        const word = this.#word(start + 1);
        const digits = this.#text.slice(start + 1, word.end);
        const isColour = word.foreign === undefined &&
            (digits.length === 6 || digits.length === 8) &&
            HEX_ONLY.test(digits);
        if (isColour) {
            this.#emit({
                kind: 'hexColor',
                span: this.#span(start, word.end - start),
                text: this.#text.slice(start, word.end),
            });
            this.#offset = word.end;
            return;
        }
        if (digits.length === 0) {
            // Nothing was written against it, so there is no colour here to have got
            // wrong: this is the character on its own (3.1).
            this.#sink.report('OS1001', this.#span(start, 1), describeUnexpected('#'));
            this.#droppedAfterToken = true;
            this.#offset = start + 1;
            return;
        }
        this.#sink.report('OS1027', this.#span(start, word.end - start), {
            written: this.#text.slice(start, word.end),
        });
        this.#droppedAfterToken = true;
        this.#offset = word.end;
    }
    #readSemicolon(start) {
        this.#sink.report('OS1007', this.#span(start, 1), {});
        this.#droppedAfterToken = true;
        this.#offset = start + 1;
        // The fix is to put the second statement on its own line, so the token
        // stream is given exactly that and the rest of the line is read as the
        // statement the writer meant. Inside brackets there is no statement to end,
        // so there the character is only dropped.
        if (this.#brackets > 0 || !this.#lineHasToken)
            return;
        this.#layout.endStatement();
        this.#emitNewline(this.#span(start, 1));
        this.#layout.beginStatement(this.#line, this.#indent);
    }
    #readPunctuation(start) {
        const pair = this.#text.slice(start, start + 2);
        if (REJECTED_PAIRS.has(pair)) {
            this.#sink.report('OS1001', this.#span(start, 2), describeUnexpected(pair));
            this.#droppedAfterToken = true;
            this.#offset = start + 2;
            return;
        }
        if (TWO_CHARACTER.has(pair)) {
            this.#emit({ kind: pair, span: this.#span(start, 2), text: pair });
            this.#offset = start + 2;
            return;
        }
        const one = this.#text.charAt(start);
        if (ONE_CHARACTER.has(one)) {
            if (OPENING_BRACKETS.has(one))
                this.#brackets++;
            else if (CLOSING_BRACKETS.has(one) && this.#brackets > 0)
                this.#brackets--;
            this.#emit({ kind: one, span: this.#span(start, 1), text: one });
            this.#offset = start + 1;
            return;
        }
        // Everything the language does not have, reported where it sits rather than
        // three tokens later (3.1). An astral character is two code units and is
        // taken whole, so a message never quotes half of one.
        const written = String.fromCodePoint(this.#text.codePointAt(start) ?? 0);
        this.#sink.report('OS1001', this.#span(start, written.length), describeUnexpected(written));
        this.#droppedAfterToken = true;
        this.#offset = start + written.length;
    }
    #word(from) {
        let i = from;
        let foreign;
        for (;;) {
            while (isNamePart(this.#text.charCodeAt(i)))
                i++;
            const point = this.#text.codePointAt(i);
            if (point === undefined || !isNonAsciiLetter(point))
                return { end: i, foreign };
            const written = String.fromCodePoint(point);
            foreign ??= { offset: i, written };
            i += written.length;
        }
    }
    // -------------------------------------------------------------------------
    // Emitting
    // -------------------------------------------------------------------------
    #emit(token) {
        this.#layout.admit(this.#continuing);
        this.#layout.observe(token.kind);
        this.#lineHasToken = true;
        this.#droppedAfterToken = false;
        this.#tokens.push(token);
    }
    /** One newline per statement, never two, and never one before a statement has begun. */
    #emitNewline(span) {
        const last = this.#tokens[this.#tokens.length - 1];
        if (last === undefined || last.kind === 'newline')
            return;
        this.#tokens.push({ kind: 'newline', span, text: '' });
    }
    #span(offset, length) {
        return this.#file.spanAt(offset, length);
    }
}
/**
 * Reads a file into tokens, reporting what it cannot read and carrying on.
 *
 * Nothing here throws. One character the language does not have should cost the
 * reader that character and not the rest of the file, so every lexical error is
 * reported against its own span and the scan resumes at the next thing it can
 * recognise.
 */
export function lex(file, diagnostics) {
    return new Lexer(file, diagnostics).run();
}
//# sourceMappingURL=lexer.js.map