import { malformed } from './errors.js';
/** Collects the first failure and stops: a malformed program has no second opinion. */
export class ShapeCheck {
    failure;
    problem() {
        return this.failure;
    }
    fail(path, reason) {
        this.failure ??= malformed(path, reason);
        return false;
    }
    object(value, path) {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            return this.fail(path, 'an object was required');
        }
        return true;
    }
    array(value, path) {
        if (!Array.isArray(value))
            return this.fail(path, 'an array was required');
        return true;
    }
    number(value, path) {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            return this.fail(path, 'a finite number was required');
        }
        return true;
    }
    whole(value, path) {
        if (!this.number(value, path))
            return false;
        if (!Number.isInteger(value))
            return this.fail(path, 'a whole number was required');
        return true;
    }
    string(value, path) {
        if (typeof value !== 'string')
            return this.fail(path, 'a string was required');
        return true;
    }
    bool(value, path) {
        if (typeof value !== 'boolean')
            return this.fail(path, 'a true or false was required');
        return true;
    }
    /** A whole number that indexes a table, with the table's size in the message. */
    index(value, path, size, table) {
        if (!this.whole(value, path))
            return false;
        if (value < 0 || value >= size) {
            return this.fail(path, `${value} is outside ${table}, which holds ${size}`);
        }
        return true;
    }
    one(value, path, allowed) {
        if (!this.string(value, path))
            return false;
        if (!allowed.includes(value)) {
            return this.fail(path, `${value} is not one of ${allowed.join(', ')}`);
        }
        return true;
    }
    /** A field that may be a value or null, which is a value the script could write. */
    nullable(value, path, check) {
        return value === null ? true : check.call(this, value, path);
    }
}
/** The tags of a constant pool entry, 2.9. */
const CONSTANT_TAGS = ['z', 'b', 'n', 's', 'c'];
export function checkConstant(shape, value, path) {
    if (!shape.array(value, path))
        return false;
    if (value.length !== 2)
        return shape.fail(path, 'a pool entry is a tag and a value');
    const tag = value[0];
    if (!shape.one(tag, `${path}[0]`, CONSTANT_TAGS))
        return false;
    const held = value[1];
    switch (tag) {
        case 'z':
            return held === null ? true : shape.fail(`${path}[1]`, 'the absent entry holds null');
        case 'b':
            return shape.bool(held, `${path}[1]`);
        case 'n':
            return shape.number(held, `${path}[1]`);
        case 's':
            return shape.string(held, `${path}[1]`);
        default:
            return checkColour(shape, held, `${path}[1]`);
    }
}
export function checkColour(shape, value, path) {
    if (!shape.array(value, path))
        return false;
    if (value.length !== 4)
        return shape.fail(path, 'a colour is four numbers');
    for (let i = 0; i < 3; i += 1) {
        if (!shape.whole(value[i], `${path}[${i}]`))
            return false;
        const channel = value[i];
        if (channel < 0 || channel > 255) {
            return shape.fail(`${path}[${i}]`, `a channel runs 0 to 255 and this is ${channel}`);
        }
    }
    if (!shape.number(value[3], `${path}[3]`))
        return false;
    const alpha = value[3];
    if (alpha < 0 || alpha > 1) {
        return shape.fail(`${path}[3]`, `an alpha runs 0 to 1 and this is ${alpha}`);
    }
    return true;
}
/**
 * A declaration field, 2.3: a value, or the `{ "input": key }` reference.
 *
 * The key half of check 10 lives here, because this is the one walk that
 * visits every field that may hold one. The value half runs later, with the
 * host's settings in hand.
 */
export function checkField(shape, value, path, keys) {
    if (value === null)
        return true;
    const kind = typeof value;
    if (kind === 'boolean' || kind === 'string')
        return true;
    if (kind === 'number')
        return shape.number(value, path);
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i += 1) {
            if (!shape.number(value[i], `${path}[${i}]`))
                return false;
        }
        return true;
    }
    if (!shape.object(value, path))
        return false;
    const key = value['input'];
    if (key === undefined)
        return shape.fail(path, 'an object here is an input reference');
    if (!shape.string(key, `${path}.input`))
        return false;
    if (!keys.has(key)) {
        return shape.fail(path, `it names the input ${key}, which inputs[] does not declare`);
    }
    return true;
}
//# sourceMappingURL=verify-shape.js.map