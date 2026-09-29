/**
 * Turning a diagnostic into something a reader sees.
 *
 * Only the terminal shape lives here. An editor puts the same diagnostic in a
 * gutter and a chart puts it over a pane, and both take the Diagnostic and the
 * span rather than this text, which is why rendering is a module of its own
 * rather than a method on the diagnostic.
 */
export { renderDiagnostic, renderDiagnostics } from './terminal.js';
//# sourceMappingURL=index.js.map