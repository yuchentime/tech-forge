const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CHAT_COLUMN_COMFORT,
  CHAT_COLUMN_FLOOR,
  PANEL_DEFAULT_WIDTH,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  SPLIT_MIN_CONTENT_WIDTH,
  clampPanelWidth,
  planArtifactLayout,
} = require('../dist-electron/src/features/agent/layout-budget.js');

/** Plans a layout with the panel preference the user has not changed yet. */
function plan(viewportContentWidth, maxContentWidth = null, requestedPanelWidth = PANEL_DEFAULT_WIDTH) {
  return planArtifactLayout({ viewportContentWidth, requestedPanelWidth, maxContentWidth });
}

test('the default window needs no growth: comfort tier fits exactly at 1264', () => {
  const result = plan(1264, 1264);
  assert.equal(result.mode, 'split');
  assert.equal(result.panelWidth, PANEL_DEFAULT_WIDTH);
  assert.equal(result.chatColumnWidth, CHAT_COLUMN_COMFORT);
  assert.equal(result.requiredContentWidth, 1264);
  assert.equal(result.needsGrowth, false);
});

test('a small window reports the comfort width it needs before the display cap is known', () => {
  const result = plan(944);
  assert.equal(result.mode, 'split');
  assert.equal(result.panelWidth, PANEL_DEFAULT_WIDTH);
  assert.equal(result.requiredContentWidth, 1264);
  assert.equal(result.needsGrowth, true);
});

test('1366 at 125% still splits: the panel narrows instead of the panel floating', () => {
  const result = plan(1077, 1077);
  assert.equal(result.mode, 'split');
  assert.equal(result.panelWidth, 325);
  assert.equal(result.chatColumnWidth, CHAT_COLUMN_FLOOR);
  assert.equal(result.needsGrowth, false);
});

test('a display that fits the floor tier keeps the preferred panel width and drops the chat', () => {
  const result = plan(1136, 1136);
  assert.equal(result.mode, 'split');
  assert.equal(result.panelWidth, PANEL_DEFAULT_WIDTH);
  assert.equal(result.chatColumnWidth, CHAT_COLUMN_FLOOR);
});

test('below the split minimum the panel floats and the chat keeps the full width', () => {
  assert.equal(SPLIT_MIN_CONTENT_WIDTH, 1072);
  const result = plan(1008, 1008);
  assert.equal(result.mode, 'overlay');
  assert.equal(result.chatColumnWidth, 1008 - 256);
  assert.equal(result.panelWidth, 384);
  assert.equal(result.requiredContentWidth, 1008);
  assert.equal(result.needsGrowth, false);
});

test('a narrow window stacks the panel instead of planning a split', () => {
  const result = plan(700);
  assert.equal(result.mode, 'stacked');
  assert.equal(result.needsGrowth, false);
});

test('a dragged preference above the comfort budget is capped at the panel maximum', () => {
  const result = plan(1264, 1904, 1200);
  assert.equal(result.mode, 'split');
  assert.equal(result.panelWidth, PANEL_MAX_WIDTH);
  // comfort need for a 900px panel: 256 rail + 624 chat + 900 panel
  assert.equal(result.requiredContentWidth, 1780);
  assert.equal(result.needsGrowth, true);
});

test('the panel is squeezed before the chat when the display cannot hold the preference', () => {
  const result = plan(1200, 1200, 900);
  assert.equal(result.mode, 'split');
  assert.equal(result.panelWidth, 448);
  assert.equal(result.chatColumnWidth, CHAT_COLUMN_FLOOR);
  assert.equal(result.requiredContentWidth, 1200);
});

test('stored panel widths are clamped into the supported range', () => {
  assert.equal(clampPanelWidth(Number.NaN), PANEL_DEFAULT_WIDTH);
  assert.equal(clampPanelWidth(120), PANEL_MIN_WIDTH);
  assert.equal(clampPanelWidth(5000), PANEL_MAX_WIDTH);
  assert.equal(clampPanelWidth(431.6), 432);
});
