const assert = require('node:assert/strict');
const test = require('node:test');
const {
  clampContentWidthRequest,
  isSnappedWidth,
  planWindowGrowth,
  resolveRestoredBounds,
  sameHorizontalBounds,
} = require('../dist-electron/electron/main/window-layout.js');

/** A 1920-wide display whose window carries the usual 16px frame. */
const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1040 };

/** Grows a 960px window to the comfort width on the standard work area. */
function grow(minContentWidth, overrides = {}) {
  return planWindowGrowth({
    bounds: { x: 100, y: 100, width: 960, height: 820 },
    contentBounds: { width: 944, height: 781 },
    workArea: WORK_AREA,
    minContentWidth,
    ...overrides,
  });
}

test('growth compensates the measured frame and keeps position', () => {
  // Height is not part of the plan: Electron creeps a pixel per call when it re-derives one.
  assert.deepEqual(grow(1264), { x: 100, width: 1280 });
});

test('growth never exceeds the display work area', () => {
  const result = grow(1400, {
    workArea: { x: 0, y: 0, width: 1366, height: 728 },
    bounds: { x: 100, y: 100, width: 960, height: 700 },
    contentBounds: { width: 944, height: 661 },
  });
  assert.equal(result.width, 1366);
  assert.equal(result.x, 0, 'a window wider than the free space slides to the work area edge');
});

test('a window near the right edge slides left instead of leaving the display', () => {
  const result = grow(1264, {
    bounds: { x: 960, y: 100, width: 960, height: 820 },
  });
  assert.equal(result.x, 640);
  assert.equal(result.x + result.width, 1920);
});

test('no growth is planned when the window is already wide enough', () => {
  assert.equal(
    grow(1264, { bounds: { x: 0, y: 0, width: 1280, height: 820 }, contentBounds: { width: 1264, height: 781 } }),
    null,
  );
});

test('renderer width requests are validated instead of silently clamped', () => {
  assert.equal(clampContentWidthRequest(1264), 1264);
  assert.equal(clampContentWidthRequest(1264.7), 1265);
  assert.throws(() => clampContentWidthRequest(Number.NaN), /无效/);
  assert.throws(() => clampContentWidthRequest('1264'), /无效/);
  assert.throws(() => clampContentWidthRequest(120), /超出范围/);
  assert.throws(() => clampContentWidthRequest(1e9), /超出范围/);
});

test('snapped windows are detected so growth does not drop the Windows snap', () => {
  assert.equal(isSnappedWidth(960, 1920), true);
  assert.equal(isSnappedWidth(480, 1920), true);
  assert.equal(isSnappedWidth(963, 1920), true);
  assert.equal(isSnappedWidth(800, 1920), false);
});

test('a stored window rect is clamped into the current work area', () => {
  assert.deepEqual(
    resolveRestoredBounds({
      stored: { x: 1900, y: 1000, width: 1200, height: 800 },
      workArea: WORK_AREA,
      minSize: { width: 960, height: 640 },
    }),
    { x: 720, y: 240, width: 1200, height: 800 },
  );
  assert.deepEqual(
    resolveRestoredBounds({
      stored: { x: -500, y: -200, width: 1600, height: 900 },
      workArea: WORK_AREA,
      minSize: { width: 960, height: 640 },
    }),
    { x: 0, y: 0, width: 1600, height: 900 },
  );
});

test('a stored rect below the minimum size is raised to the minimum', () => {
  assert.deepEqual(
    resolveRestoredBounds({
      stored: { x: 10, y: 10, width: 700, height: 500 },
      workArea: WORK_AREA,
      minSize: { width: 960, height: 640 },
    }),
    { x: 10, y: 10, width: 960, height: 640 },
  );
});

test('missing or broken stored bounds are ignored', () => {
  const workArea = WORK_AREA;
  const minSize = { width: 960, height: 640 };
  assert.equal(resolveRestoredBounds({ stored: null, workArea, minSize }), null);
  assert.equal(
    resolveRestoredBounds({ stored: { x: 0, y: 0, width: 0, height: 700 }, workArea, minSize }),
    null,
  );
  assert.equal(
    resolveRestoredBounds({ stored: { x: Number.NaN, y: 0, width: 1280, height: 820 }, workArea, minSize }),
    null,
  );
});

test('restore comparison looks at x and width only, with rounding slack', () => {
  const bounds = { x: 100, width: 1280 };
  assert.equal(sameHorizontalBounds(bounds, { x: 100, width: 1280.4 }), true);
  assert.equal(sameHorizontalBounds(bounds, { x: 101, width: 1281 }), true);
  assert.equal(sameHorizontalBounds(bounds, { x: 100, width: 1284 }), false);
  assert.equal(sameHorizontalBounds(bounds, { x: 160, width: 1280 }), false);
});
