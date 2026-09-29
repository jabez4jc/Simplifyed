/**
 * OpenScript, the compiler and the engine.
 *
 * This is the whole of what a host needs to take a script and produce values,
 * and it knows nothing about a chart, an editor or a broker. It imports no
 * package and touches no browser global, so the same file runs in a worker, on
 * a server and inside somebody else's application under a content security
 * policy that forbids turning text into code.
 *
 * Three things a host does, and the names that do them:
 *
 *     sourceFile, parse, check, emit   source text becomes a compiled program
 *     load                             a program is verified and made runnable
 *     Engine.run, Engine.append        it runs over bars, and values come out
 *
 * Every name below is a promise to somebody who is not in this repository, so
 * the surface is a decision rather than everything the modules hold: a pass, a
 * table or an instruction stays behind its module's door, and a host never has
 * to reach past this file to compile or run a script.
 *
 * The tiers above it are separate entry points, so a host that wants only this
 * one never loads the editor intelligence or an adapter.
 */
export { containsOffset, endOffset, makeSpan, spanning } from './span/index.js';
export { normaliseSource, sourceFile } from './source/index.js';
export { CATALOGUE_LANGUAGE_VERSION, CATALOGUE_SCHEMA_VERSION, STAGE_LABELS, allCodes, entryFor, fillTemplate, isDiagnosticCode, } from './catalogue/index.js';
export { DiagnosticBag, diagnosticFor, isError } from './diagnostics/index.js';
export { renderDiagnostic, renderDiagnostics } from './render/index.js';
export { PUNCTUATORS, RESERVED_WORDS } from './tokens/index.js';
export { ARITHMETIC_OPERATORS, ASSIGNMENT_OPERATORS, COMPARISON_OPERATORS, EQUALITY_OPERATORS, LOGICAL_OPERATORS, OBJECT_TYPE_NAMES, UNARY_OPERATORS, VALUE_TYPE_NAMES, binaryPrecedence, childrenOf, isExpression, isObjectTypeName, isStatement, isTypeAnnotation, isValueTypeName, makeNode, nodeAtOffset, pathAtOffset, typeAnnotationText, walk, withoutGrouping, } from './ast/index.js';
export { lex } from './lex/index.js';
export { parse, parseTokens } from './parse/index.js';
export { BAR_ZERO, HANDLE_KINDS, NAMESPACES, OBJECT_KINDS, STRATEGY_NAMESPACES, VALUE_KINDS, accepts, allOf, arrayOf, atBar, atLeastBar, check, delayed, describedNames, earlier, elementOf, isLibraryName, isNamespace, isNever, isSeries, join, later, libraryEntries, libraryNames, membersOf, sameType, seriesOf, proseFor, typeText, } from './check/index.js';
export { REQUEST_NAMES } from './check/index.js';
export { COMPILED_FORMAT_VERSION, VERSION } from './version/index.js';
/**
 * The emitter: a checked script becomes the compiled program.
 *
 * The program is plain data, so a host may store it, send it, and run it here
 * or on an engine somebody else wrote from the specification.
 *
 * `canonicalise` is the encoding the two hashes are taken over and the bytes
 * that travel. A host that records the source hash and the program hash beside
 * a result can later prove an engine upgrade did not change it, which is what
 * `compiled-program.md` 9.5 promises.
 */
export { emit } from './emit/index.js';
export { canonicalise, programHash, sourceHash } from './emit/index.js';
/**
 * Two answers the emitter holds that a tool built on the language needs.
 *
 * A declaration call's defaults and the channels a colour name denotes are both
 * facts the compiler applies and neither is in the library manifest, so a tier
 * above this one that read the manifest alone would show a writer nothing where
 * the compiler has a value. They are here rather than reached for behind the
 * emitter's door, and `scripts/check-defaults.mjs` holds the first of them to
 * what `stdlib.md` prints.
 */
export { DECLARATION_CALLS, declarationDefaultText, namedColour } from './emit/index.js';
/**
 * The engine: a program in, one bar at a time, values out.
 *
 * `load` verifies the program in full before a bar executes and answers with a
 * diagnostic rather than an exception, because a host runs many scripts in one
 * process and one failing script must take nothing else down. `verify` is that
 * same check on its own, for a host that keeps compiled programs and wants to
 * refuse a bad one when it arrives rather than when it is first drawn.
 *
 * `loadText` is `load` for a program that arrives as text, which is the one
 * boundary where the canonical encoding is required (`compiled-program.md`
 * section 13): text that parses to a program but is not that encoding is
 * refused, because the hash a host recorded was taken over canonical bytes.
 *
 * `capabilitiesFor` and `LANGUAGE_VERSIONS` are this engine's half of the
 * compatibility statement in 9.1, beside `COMPILED_FORMAT_VERSION` above.
 */
export { load, loadText } from './engine/index.js';
export { DEFAULT_LIMITS } from './engine/index.js';
export { isAbsent } from './engine/index.js';
export { LANGUAGE_VERSIONS, capabilitiesFor, verify } from './engine/index.js';
/**
 * The importer: a script written in another chart language in, OpenScript text
 * and findings out (`docs/writing/importing-a-script.md`).
 *
 * It sits beside the compiler because it is the same kind of thing, a pure
 * function from text to text with diagnostics, and because it compiles its own
 * output before returning it so that what it hands back compiles. Every finding
 * carries a catalogue code in the OS9xxx range and a position in the text that
 * was imported, not in the text that came out.
 */
export { importScript } from './importer/index.js';
export { chargeFor, scheduleFromDeclaration, scheduleProblem } from './accounting/index.js';
export { markersOf, monthlyOver, reportOf } from './accounting/index.js';
export { tradesOf } from './accounting/index.js';
export { analysisOf, equityOver, summaryOf } from './accounting/index.js';
export { DEFAULT_FILL, EXACT, WHOLE_RANGE, RECORD_VERSION, backtest, backtestSupplied, barsHash, caseFilesFrom, checkSettings, compareRuns, recordFromJson, recordToJson, recordOf, replay, rerun, runBytes, settingsFor, windowFor, } from './backtest/index.js';
//# sourceMappingURL=index.js.map