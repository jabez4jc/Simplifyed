import assert from 'assert';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Pattern detection is the most silent code on the chart. A mislabelled Hammer still draws a
 * tidy marker under a bar and reads as a signal, so each rule is pinned against a hand-built
 * candle that matches the classical definition - and, where two patterns share a shape and
 * differ only by context (Hammer / Hanging Man, Morning Star / Morning Doji Star), against the
 * near-miss that must NOT fire.
 */
const dir = path.dirname(fileURLToPath(import.meta.url));
new Function(fs.readFileSync(path.join(dir, '../../public/js/chart-patterns.js'), 'utf8'))();
const P = globalThis.ChartPatterns;

let t = 1700000000;
const bar = (open, high, low, close) => ({ time: (t += 300), open, high, low, close });

/** A run of ordinary bars trending in `dir`, used as the context several patterns require. */
const run = (n, dir, start = 100, step = 2) =>
  Array.from({ length: n }, (_, i) => {
    const base = start + dir * step * i;
    return dir >= 0
      ? bar(base, base + 1.5, base - 0.5, base + 1)
      : bar(base, base + 0.5, base - 1.5, base - 1);
  });

const hits = (candles, id) => P.detect(candles, [id]).map((h) => h.time);
const fires = (candles, id) => hits(candles, id).includes(candles[candles.length - 1].time);

test('Doji needs a body no larger than 5% of the range', () => {
  assert.ok(fires([bar(100, 105, 95, 100.1)], 'doji'));
  assert.ok(!fires([bar(100, 105, 95, 103)], 'doji'), 'a real body is not a doji');
});

test('Dragonfly and Gravestone are distinguished by which shadow is long', () => {
  assert.ok(fires([bar(105, 105.1, 95, 105)], 'dragonflyDoji'));
  assert.ok(!fires([bar(105, 105.1, 95, 105)], 'gravestoneDoji'));
  assert.ok(fires([bar(95, 105, 94.9, 95)], 'gravestoneDoji'));
  assert.ok(!fires([bar(95, 105, 94.9, 95)], 'dragonflyDoji'));
});

test('Hammer and Hanging Man share a shape and differ only by the preceding trend', () => {
  const shape = bar(100, 101, 92, 100.8);
  const afterDowntrend = [...run(8, -1), shape];
  const afterUptrend = [...run(8, 1), shape];

  assert.ok(fires(afterDowntrend, 'hammer'), 'hammer needs a downtrend');
  assert.ok(!fires(afterDowntrend, 'hangingMan'));
  assert.ok(fires(afterUptrend, 'hangingMan'), 'hanging man needs an uptrend');
  assert.ok(!fires(afterUptrend, 'hammer'), 'the same shape in an uptrend is NOT a hammer');
});

test('Inverted Hammer and Shooting Star likewise', () => {
  const shape = bar(100, 108, 99.5, 100.8);
  assert.ok(fires([...run(8, -1), shape], 'invertedHammer'));
  assert.ok(fires([...run(8, 1), shape], 'shootingStar'));
  assert.ok(!fires([...run(8, 1), shape], 'invertedHammer'));
});

test('Engulfing requires the body to cover the previous body entirely', () => {
  const bullish = [bar(100, 101, 96, 97), bar(96.5, 102, 96, 101)];
  assert.ok(fires(bullish, 'engulfingBullish'));

  // One tick short of covering the prior open is not an engulfing.
  const short = [bar(100, 101, 96, 97), bar(96.5, 100, 96, 99.5)];
  assert.ok(!fires(short, 'engulfingBullish'));

  const bearish = [bar(97, 102, 96, 101), bar(101.5, 102, 95, 96)];
  assert.ok(fires(bearish, 'engulfingBearish'));
  assert.ok(!fires(bearish, 'engulfingBullish'));
});

test('Harami is the inverse containment of Engulfing', () => {
  const ctx = run(10, 0);
  const bullish = [...ctx, bar(120, 121, 99, 100), bar(105, 112, 104, 110)];
  assert.ok(fires(bullish, 'haramiBullish'));
  assert.ok(!fires(bullish, 'engulfingBullish'), 'containment is not engulfing');
});

test('Harami Cross needs the inside bar to be a doji', () => {
  const ctx = run(10, 0);
  assert.ok(fires([...ctx, bar(120, 121, 99, 100), bar(110, 112, 108, 110.05)], 'haramiCrossBullish'));
  assert.ok(!fires([...ctx, bar(120, 121, 99, 100), bar(105, 112, 104, 110)], 'haramiCrossBullish'));
});

test('Piercing must close above the midpoint but below the open', () => {
  const ctx = run(10, 0);
  const prev = bar(120, 121, 99, 100); // long bearish, midpoint 110
  assert.ok(fires([...ctx, prev, bar(98, 116, 97, 115)], 'piercing'));
  // Closing below the midpoint is a failed piercing, not a weak one.
  assert.ok(!fires([...ctx, prev, bar(98, 108, 97, 105)], 'piercing'));
  // Closing above the prior open would be an engulfing instead.
  assert.ok(!fires([...ctx, prev, bar(98, 125, 97, 122)], 'piercing'));
});

test('Dark Cloud Cover is the bearish mirror', () => {
  const ctx = run(10, 0);
  const prev = bar(100, 121, 99, 120); // long bullish, midpoint 110
  assert.ok(fires([...ctx, prev, bar(122, 123, 104, 105)], 'darkCloudCover'));
  assert.ok(!fires([...ctx, prev, bar(122, 123, 114, 115)], 'darkCloudCover'), 'must breach the midpoint');
});

test('Windows are pure gaps, with no shadow overlap', () => {
  assert.ok(fires([bar(100, 102, 99, 101), bar(105, 107, 103, 106)], 'risingWindow'));
  assert.ok(!fires([bar(100, 102, 99, 101), bar(103, 107, 101.5, 106)], 'risingWindow'),
    'overlapping shadows leave no window');
  assert.ok(fires([bar(105, 107, 103, 106), bar(100, 102, 99, 101)], 'fallingWindow'));
});

test('Morning Star needs a long body, a small middle and a close past the midpoint', () => {
  const ctx = run(10, 0);
  const first = bar(120, 121, 99, 100);      // long bearish, midpoint 110
  const star = bar(97, 98, 96, 97.5);        // small, gapped below
  assert.ok(fires([...ctx, first, star, bar(99, 116, 98, 115)], 'morningStar'));
  // Closing short of the midpoint is not a reversal.
  assert.ok(!fires([...ctx, first, star, bar(99, 106, 98, 105)], 'morningStar'));
});

test('Morning Doji Star fires only when the middle bar is a doji', () => {
  const ctx = run(10, 0);
  const first = bar(120, 121, 99, 100);
  assert.ok(fires([...ctx, first, bar(97, 98, 96, 97.02), bar(99, 116, 98, 115)], 'morningDojiStar'));
  assert.ok(!fires([...ctx, first, bar(97, 98, 96, 97.5), bar(99, 116, 98, 115)], 'morningDojiStar'));
});

test('Abandoned Baby needs an isolating gap on BOTH sides', () => {
  const ctx = run(10, 0);
  const first = bar(120, 121, 110, 111);
  const doji = bar(105, 105.4, 104.6, 105.02);
  assert.ok(fires([...ctx, first, doji, bar(108, 118, 107, 117)], 'abandonedBabyBullish'));
  // Second gap closed: an ordinary morning doji star, not an abandoned baby.
  assert.ok(!fires([...ctx, first, doji, bar(103, 118, 102, 117)], 'abandonedBabyBullish'));
});

test('Three White Soldiers requires each open inside the previous body', () => {
  const good = [bar(100, 106, 99, 105), bar(102, 111, 101, 110), bar(107, 116, 106, 115)];
  assert.ok(fires(good, 'threeWhiteSoldiers'));
  // Gapping open above the previous close breaks the pattern.
  const gapped = [bar(100, 106, 99, 105), bar(107, 111, 106, 110), bar(112, 116, 111, 115)];
  assert.ok(!fires(gapped, 'threeWhiteSoldiers'));
});

test('Three Black Crows is the bearish mirror', () => {
  const good = [bar(115, 116, 109, 110), bar(113, 114, 104, 105), bar(108, 109, 99, 100)];
  assert.ok(fires(good, 'threeBlackCrows'));
  assert.ok(!fires(good, 'threeWhiteSoldiers'));
});

test('Marubozu allows almost no shadow', () => {
  const ctx = run(10, 0);
  assert.ok(fires([...ctx, bar(100, 120.1, 99.9, 120)], 'marubozuWhite'));
  assert.ok(!fires([...ctx, bar(100, 125, 95, 120)], 'marubozuWhite'), 'long shadows disqualify it');
  assert.ok(fires([...ctx, bar(120, 120.1, 99.9, 100)], 'marubozuBlack'));
});

test('Rising Three Methods needs three contained bars between two long ones', () => {
  const ctx = run(10, 0);
  const seq = [
    bar(100, 120, 99, 119),
    bar(115, 117, 110, 112), bar(114, 116, 109, 111), bar(113, 118, 108, 110),
    bar(112, 130, 111, 128),
  ];
  assert.ok(fires([...ctx, ...seq], 'risingThreeMethods'));

  // One middle bar breaking outside the first bar's range invalidates it.
  const broken = [...seq];
  broken[2] = bar(114, 125, 109, 111);
  assert.ok(!fires([...ctx, ...broken], 'risingThreeMethods'));
});

test('detect returns bar-ordered hits and ignores unknown ids', () => {
  const candles = [...run(8, -1), bar(100, 101, 92, 100.8)];
  const out = P.detect(candles, ['hammer', 'nonsense']);
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual(Object.keys(out[0]).sort(), ['bullish', 'id', 'label', 'short', 'time']);
  assert.strictEqual(out[0].label, 'Hammer');

  assert.deepStrictEqual(P.detect(candles, []), []);
  assert.deepStrictEqual(P.detect([], ['hammer']), []);
  assert.deepStrictEqual(P.detect(null, ['hammer']), []);
});

test('every pattern has a unique, short marker code', () => {
  // The code is what gets drawn. A duplicate makes two different patterns indistinguishable on
  // the chart, and a long one reintroduces the overlap the codes exist to avoid.
  const codes = P.PATTERNS.map((p) => p.short);
  assert.strictEqual(new Set(codes).size, codes.length, 'marker codes must be unique');
  for (const p of P.PATTERNS) {
    assert.ok(p.short, `${p.id} needs a marker code`);
    assert.ok(p.short.length <= 4, `${p.id} code "${p.short}" is too long for a marker`);
    assert.match(p.short, /^[A-Z0-9+-]+$/, `${p.id} code "${p.short}" should be plain uppercase`);
  }

  // A bullish/bearish pair must not share a code - colour alone is not enough on a dense chart.
  const byLabel = new Map(P.PATTERNS.map((p) => [p.label, p.short]));
  for (const [label, code] of byLabel) {
    const twin = label.includes('Bullish') ? label.replace('Bullish', 'Bearish')
      : label.includes('Bearish') ? label.replace('Bearish', 'Bullish') : null;
    if (twin && byLabel.has(twin)) assert.notStrictEqual(code, byLabel.get(twin), `${label} vs ${twin}`);
  }
});

test('detect returns the marker code alongside the full name', () => {
  const candles = [...run(8, -1), bar(100, 101, 92, 100.8)];
  const [hit] = P.detect(candles, ['hammer']);
  assert.strictEqual(hit.short, 'HMR');
  assert.strictEqual(hit.label, 'Hammer');
});

test('every declared pattern has a unique id and runs without throwing', () => {
  const ids = P.PATTERNS.map((p) => p.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'pattern ids must be unique');
  assert.ok(ids.length >= 40, `expected the full classical set, got ${ids.length}`);

  // Degenerate bars (a flat contract, a zero-range print) must not take the chart down.
  const degenerate = Array.from({ length: 12 }, () => bar(100, 100, 100, 100));
  assert.doesNotThrow(() => P.detect(degenerate, ids));
});

test('patterns needing history do not fire on a short series', () => {
  const two = [bar(100, 106, 99, 105), bar(102, 111, 101, 110)];
  for (const id of ['threeWhiteSoldiers', 'morningStar', 'risingThreeMethods', 'abandonedBabyBullish']) {
    assert.deepStrictEqual(P.detect(two, [id]), [], `${id} must not fire without enough bars`);
  }
});
