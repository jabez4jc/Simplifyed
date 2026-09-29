/**
 * A slot, in the one syntax the catalogue declares. The name is restricted to
 * an identifier so that a brace in a message that is not a slot, which the
 * catalogue is free to contain, is left alone.
 */
const SLOT = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;
/**
 * Fills a catalogue template.
 *
 * A slot with no value is left written out rather than blanked. A reader who
 * sees `{name}` on screen knows the compiler failed to supply something, which
 * is a defect they can report; a reader who sees a sentence with a hole in it
 * only knows the sentence reads oddly. Supplying every slot is guaranteed at
 * compile time by DiagnosticValues, so this case is a bug in the compiler
 * rather than something a script can cause.
 */
export function fillTemplate(template, values) {
    return template.replace(SLOT, (slot, name) => {
        const value = values[name];
        return value === undefined ? slot : String(value);
    });
}
/** The slots a template uses, in order, with duplicates removed. */
export function slotsIn(template) {
    const names = [];
    for (const match of template.matchAll(SLOT)) {
        const name = match[1];
        if (name !== undefined && !names.includes(name))
            names.push(name);
    }
    return names;
}
//# sourceMappingURL=template.js.map