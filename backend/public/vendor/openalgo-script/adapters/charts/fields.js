import { isColourValue } from './colours.js';
export function isReference(field) {
    return typeof field === 'object' && field !== null && !Array.isArray(field);
}
/** A field as a value, with any input reference resolved. */
export function fieldOf(field, lookup) {
    if (field === null)
        return null;
    if (isReference(field))
        return lookup(field.input);
    if (Array.isArray(field))
        return colourFrom(field);
    return field;
}
/** A field that holds a colour, or nothing when it holds none. */
export function colourField(field, lookup) {
    const value = fieldOf(field, lookup);
    return isColourValue(value) ? value : undefined;
}
export function numberField(field, lookup, fallback) {
    const value = fieldOf(field, lookup);
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
export function stringField(field, lookup, fallback) {
    const value = fieldOf(field, lookup);
    return typeof value === 'string' ? value : fallback;
}
export function boolField(field, lookup) {
    const value = fieldOf(field, lookup);
    return typeof value === 'boolean' ? value : undefined;
}
/** A field that holds `[min, max]`, or nothing when it holds no such pair. */
export function rangeField(field, lookup) {
    const value = isReference(field) ? lookup(field.input) : field;
    if (!Array.isArray(value) || value.length !== 2)
        return null;
    const [min, max] = value;
    if (typeof min !== 'number' || typeof max !== 'number')
        return null;
    if (!Number.isFinite(min) || !Number.isFinite(max))
        return null;
    return { min, max };
}
/** The four numbers a colour field carries, as the value model holds them. */
function colourFrom(field) {
    if (field.length !== 4)
        return null;
    const [r, g, b, a] = field;
    return { tag: 'color', r, g, b, a };
}
//# sourceMappingURL=fields.js.map