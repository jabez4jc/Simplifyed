/**
 * SHA-256, and the UTF-8 encoding it runs over.
 *
 * `compiled-program.md` 2.14 makes `source.hash` the lowercase hexadecimal
 * SHA-256 of the UTF-8 source text, and a host records it against a chart, a
 * backtest run and a live process: it is what makes a result reproducible
 * months later. So it cannot be optional and it cannot come from a package,
 * because nothing under `src/core` may import one, and it cannot come from a
 * platform's own crypto either, because the same file has to run in a worker,
 * on a server and inside somebody else's application.
 *
 * Written from FIPS 180-4. It is small, it is exact, and it is tested against
 * the published vectors rather than against itself.
 */
const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
/**
 * UTF-8 bytes of a string, counting by code point.
 *
 * A lone surrogate cannot be encoded and becomes the replacement character,
 * which is what every other encoder does and what the lexer has already made
 * unreachable from a source file.
 */
export function utf8(text) {
    const bytes = [];
    for (const character of text) {
        let point = character.codePointAt(0) ?? 0xfffd;
        if (point >= 0xd800 && point <= 0xdfff)
            point = 0xfffd;
        if (point < 0x80) {
            bytes.push(point);
        }
        else if (point < 0x800) {
            bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
        }
        else if (point < 0x10000) {
            bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
        }
        else {
            bytes.push(0xf0 | (point >> 18), 0x80 | ((point >> 12) & 0x3f), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
        }
    }
    return Uint8Array.from(bytes);
}
function rotateRight(x, n) {
    return ((x >>> n) | (x << (32 - n))) >>> 0;
}
export function sha256(text) {
    const message = utf8(text);
    const bitLength = message.length * 8;
    // The padding of FIPS 180-4 section 5.1.1: a one bit, zeroes, and the length
    // as a 64 bit big-endian count of bits.
    const padded = new Uint8Array(((message.length + 9 + 63) >> 6) << 6);
    padded.set(message);
    padded[message.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000), false);
    view.setUint32(padded.length - 4, bitLength >>> 0, false);
    const h = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];
    const w = new Array(64).fill(0);
    for (let block = 0; block < padded.length; block += 64) {
        for (let i = 0; i < 16; i += 1)
            w[i] = view.getUint32(block + i * 4, false);
        for (let i = 16; i < 64; i += 1) {
            const a = w[i - 15] ?? 0;
            const b = w[i - 2] ?? 0;
            const s0 = rotateRight(a, 7) ^ rotateRight(a, 18) ^ (a >>> 3);
            const s1 = rotateRight(b, 17) ^ rotateRight(b, 19) ^ (b >>> 10);
            w[i] = (((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0);
        }
        let [a, b, c, d, f, g, hh, i0] = [h[0] ?? 0, h[1] ?? 0, h[2] ?? 0, h[3] ?? 0, h[4] ?? 0, h[5] ?? 0, h[6] ?? 0, h[7] ?? 0];
        for (let i = 0; i < 64; i += 1) {
            const s1 = rotateRight(f, 6) ^ rotateRight(f, 11) ^ rotateRight(f, 25);
            const choose = (f & g) ^ (~f & hh);
            const temp1 = (i0 + s1 + choose + (K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
            const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
            const majority = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (s0 + majority) >>> 0;
            i0 = hh;
            hh = g;
            g = f;
            f = (d + temp1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (temp1 + temp2) >>> 0;
        }
        h[0] = ((h[0] ?? 0) + a) >>> 0;
        h[1] = ((h[1] ?? 0) + b) >>> 0;
        h[2] = ((h[2] ?? 0) + c) >>> 0;
        h[3] = ((h[3] ?? 0) + d) >>> 0;
        h[4] = ((h[4] ?? 0) + f) >>> 0;
        h[5] = ((h[5] ?? 0) + g) >>> 0;
        h[6] = ((h[6] ?? 0) + hh) >>> 0;
        h[7] = ((h[7] ?? 0) + i0) >>> 0;
    }
    return h.map((one) => one.toString(16).padStart(8, '0')).join('');
}
//# sourceMappingURL=sha256.js.map