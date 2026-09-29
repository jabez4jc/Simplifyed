import { alertKey } from '../check/index.js';
import { ALERT_DEFAULTS, MARKER_DEFAULTS } from './defaults.js';
import { emitExpression } from './expressions.js';
import { argumentFor, fieldFor } from './outputs.js';
export function emitEventCall(e, f, call, name) {
    switch (name) {
        case 'signal':
            emitMarker(e, f, call);
            return;
        case 'alert':
            emitAlert(e, f, call);
            return;
        case 'barColor':
            e.barColor = { channel: emitPaint(e, f, call, e.barColor?.channel, 'bar colour') };
            return;
        case 'background':
            e.background = { channel: emitPaint(e, f, call, e.background?.channel, 'background') };
            return;
        default:
            return;
    }
}
/**
 * One entry per `signal()` call site, and a channel that is held back on a bar
 * that is still moving.
 *
 * A marker is emitted when its channel holds a string for the bar and not
 * otherwise, so a call site inside an `if` produces a marker on the bars the
 * branch was taken and nothing anywhere else. The channel is not declared
 * `once` for that reason: a signal may sit under a condition, which is the
 * whole point of one.
 */
function emitMarker(e, f, call) {
    const text = argumentFor(e, call, 'text');
    // A marker's channel is named after the text it carries when that is a
    // literal, which is what 12.2's `debug.names.channels` shows.
    const literal = text === undefined ? undefined : e.fold(text.value);
    const name = literal?.kind === 'string' ? literal.value : `marker ${e.markers.length}`;
    const channel = e.layout.channel('string', true, false, name);
    if (text === undefined) {
        f.builder.at(call.span);
        f.builder.push('CONST', e.pool.absent());
    }
    else {
        emitExpression(e, f, text.value);
    }
    f.builder.at(call.span);
    f.builder.push('EMIT', channel);
    e.markers.push({
        key: `m${e.markers.length}`,
        channel,
        position: fieldFor(e, call, 'at', MARKER_DEFAULTS),
        shape: fieldFor(e, call, 'shape', MARKER_DEFAULTS),
        color: fieldFor(e, call, 'color', MARKER_DEFAULTS),
        // `markers[].textColor` has no argument in the library: `signal` takes one
        // colour and it is the plate's. Null is the effective value of a field no
        // script can express, which is 2.8's own reading of a table's text size.
        textColor: null,
    });
}
function emitAlert(e, f, call) {
    const id = fieldFor(e, call, 'id', ALERT_DEFAULTS);
    // `id` is the stable name of the entry, so a user's alert subscription
    // survives an edit to the script. With none, the compiler derives one from
    // the call's position, which is what OS8008 already warns about, and the
    // checker refuses two alerts that would land under one name with OS3017.
    const key = alertKey(typeof id === 'string' ? id : undefined, call.span.line);
    const condChannel = e.layout.channel('bool', true, false, key);
    const messageChannel = e.layout.channel('string', true, false, `${key} message`);
    f.builder.at(call.span);
    f.builder.push('CONST', e.pool.bool(true));
    f.builder.push('EMIT', condChannel);
    const message = argumentFor(e, call, 'message');
    if (message === undefined) {
        f.builder.at(call.span);
        f.builder.push('CONST', e.pool.absent());
    }
    else {
        emitExpression(e, f, message.value);
    }
    f.builder.at(call.span);
    f.builder.push('EMIT', messageChannel);
    e.alerts.push({
        key,
        title: fieldFor(e, call, 'title', ALERT_DEFAULTS),
        condChannel,
        messageChannel,
        frequency: fieldFor(e, call, 'frequency', ALERT_DEFAULTS),
    });
}
/**
 * `barColor` and `background`: one channel each per program.
 *
 * A script with three `barColor()` calls writes the same channel three times
 * and the last write on the bar wins, which is the same rule as any other
 * channel and needs no sentence of its own (2.8).
 */
function emitPaint(e, f, call, existing, name) {
    const channel = existing ?? e.layout.channel('color', false, false, name);
    const colour = argumentFor(e, call, 'color');
    if (colour === undefined) {
        f.builder.at(call.span);
        f.builder.push('CONST', e.pool.absent());
    }
    else {
        emitExpression(e, f, colour.value);
    }
    f.builder.at(call.span);
    f.builder.push('EMIT', channel);
    return channel;
}
//# sourceMappingURL=events.js.map