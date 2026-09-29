/**
 * The renderer for a terminal, and the shape is the one errors.md section 2
 * fixes as the contract:
 *
 *     14 |     len = 9
 *        |     ^^^
 *     OS2002: len is already declared at line 1, so a second one cannot be declared here.
 *     Fix: rename this one, or drop the inner declaration and let the assignment update the len at line 1.
 *
 * The line, then the caret, then what happened, then what to do. The fix is on
 * its own line because it is the line the reader acts on, and a reader who has
 * understood the message from the caret alone should be able to skip to it.
 */
/** A tab is one column wide here, so the caret below the line still lines up. */
const TAB_WIDTH_FOR_DISPLAY = ' ';
function countCharacters(text) {
    // Code points, not code units: a terminal draws one character per code point,
    // and padding by code units would push the caret right by one for every
    // astral character earlier on the line. See the span module on columns.
    return [...text].length;
}
export function renderDiagnostic(file, diagnostic) {
    const { line, column, length } = diagnostic.span;
    const shown = file.lineText(line).replace(/\t/g, TAB_WIDTH_FOR_DISPLAY);
    const lineNumber = String(line);
    const gutter = ' '.repeat(lineNumber.length);
    const beforeCaret = shown.slice(0, Math.max(column - 1, 0));
    // A span that runs past the end of its line, which an unterminated bracket
    // produces, is drawn to the end of the line rather than off it.
    const underCaret = shown.slice(beforeCaret.length, beforeCaret.length + length);
    const caretWidth = Math.max(countCharacters(underCaret), 1);
    return [
        `${lineNumber} | ${shown}`,
        `${gutter} | ${' '.repeat(countCharacters(beforeCaret))}${'^'.repeat(caretWidth)}`,
        `${diagnostic.code}: ${diagnostic.message}`,
        `Fix: ${diagnostic.fix}`,
    ].join('\n');
}
/**
 * Every diagnostic, in the order a reader walks the file, separated by a blank
 * line. The file's name is printed once above them rather than on each one,
 * because a compile reports on one file and repeating its name on twenty
 * diagnostics buries the twenty.
 */
export function renderDiagnostics(file, diagnostics) {
    if (diagnostics.length === 0)
        return '';
    const body = diagnostics.map((diagnostic) => renderDiagnostic(file, diagnostic));
    return [`${file.name}`, ...body].join('\n\n');
}
//# sourceMappingURL=terminal.js.map