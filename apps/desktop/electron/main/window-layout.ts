/**
 * Window geometry for the artifact panel's width budget.
 *
 * The renderer states how wide its content must be; this module converts that into window bounds
 * that respect the display's work area. Everything here is pure so the arithmetic (frame
 * compensation, edge clamping, snap detection, restore validation) is testable without a window.
 */

export type WindowRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * The part of the bounds growth changes: the left edge and the width.
 *
 * Vertical geometry is deliberately absent. Electron re-derives a missing height from the content
 * rect and adds the frame again, which creeps a pixel per call at non-integer scaling, so the
 * caller always passes a stable y/height baseline of its own.
 */
export type WindowGrowth = {
  x: number;
  width: number;
};

export type Size = { width: number; height: number };

/** Lowest content width a renderer may request; below this the layout is the stacked one. */
export const MIN_CONTENT_WIDTH = 768;

/** Highest content width a renderer may request; guards against absurd or corrupted values. */
export const MAX_CONTENT_WIDTH = 8192;

/** Windows keeps the window at these fractions of the work area when it is snapped. */
const SNAP_DIVISIONS = [2, 4];

/** Pixel slack when matching a snapped width; DPI rounding makes exact equality unreliable. */
const SNAP_TOLERANCE = 4;

/**
 * True when the horizontal bounds match.
 *
 * Growth only ever changes x and width, and Electron re-derives the height from the content rect
 * with DPI rounding, so comparing the vertical axis would refuse restores for a reason that is
 * not the user's doing.
 */
export function sameHorizontalBounds(
  left: { x: number; width: number },
  right: { x: number; width: number },
): boolean {
  return (
    Math.abs(left.x - right.x) <= 1 &&
    Math.abs(left.width - right.width) <= 1
  );
}

/** Validates a renderer request, throwing instead of silently clamping a wrong value. */
export function clampContentWidthRequest(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('窗口宽度请求无效。');
  }
  const rounded = Math.round(value);
  if (rounded < MIN_CONTENT_WIDTH || rounded > MAX_CONTENT_WIDTH) {
    throw new Error('窗口宽度请求超出范围。');
  }
  return rounded;
}

/**
 * True when the window looks snapped to half or a quarter of its display.
 *
 * Growing a snapped window makes Windows drop the snap, which is a bigger surprise than the panel
 * not being able to grow, so the caller falls back to the floating panel instead.
 */
export function isSnappedWidth(width: number, workAreaWidth: number): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(workAreaWidth)) return false;
  return SNAP_DIVISIONS.some(
    (divisions) => Math.abs(width - workAreaWidth / divisions) <= SNAP_TOLERANCE,
  );
}

export type GrowthInput = {
  bounds: WindowRect;
  contentBounds: Size;
  workArea: WindowRect;
  minContentWidth: number;
};

/**
 * Computes the horizontal bounds change that gives the renderer at least `minContentWidth`.
 *
 * Returns `null` when the window is already wide enough or when the display cannot grow any
 * further. Height never changes; the window keeps its x unless that would push it off the screen,
 * in which case it slides left just enough to stay inside the work area.
 */
export function planWindowGrowth(input: GrowthInput): WindowGrowth | null {
  const { bounds, contentBounds, workArea } = input;
  // Measured, not assumed: the frame is 16px at 100% on Windows but scales with DPI.
  const frame = Math.max(0, bounds.width - contentBounds.width);
  const maxContentWidth = Math.max(
    MIN_CONTENT_WIDTH,
    workArea.width - frame,
  );
  const targetContentWidth = Math.min(input.minContentWidth, maxContentWidth);
  if (targetContentWidth <= contentBounds.width) return null;

  const width = targetContentWidth + frame;
  const rightmostX = workArea.x + workArea.width - width;
  const x = Math.min(
    Math.max(bounds.x, workArea.x),
    Math.max(workArea.x, rightmostX),
  );
  return { x, width };
}

export type RestoreInput = {
  stored: Partial<WindowRect> | null;
  workArea: WindowRect;
  minSize: Size;
};

/**
 * Turns a persisted window rect into usable bounds, or `null` when nothing usable was stored.
 *
 * The window may have been saved on a larger display, so the rect is clamped into the current work
 * area (and to the configured minimum size) instead of restoring a window the user cannot reach.
 */
export function resolveRestoredBounds(input: RestoreInput): WindowRect | null {
  const stored = input.stored;
  if (!stored) return null;
  const { x, y, width, height } = stored;
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number'
  ) {
    return null;
  }
  if (![x, y, width, height].every(Number.isFinite)) return null;
  if (width <= 0 || height <= 0) return null;

  const { workArea, minSize } = input;
  const resolvedWidth = Math.max(
    Math.min(minSize.width, workArea.width),
    Math.min(Math.round(width), workArea.width),
  );
  const resolvedHeight = Math.max(
    Math.min(minSize.height, workArea.height),
    Math.min(Math.round(height), workArea.height),
  );
  const resolvedX = Math.min(
    Math.max(Math.round(x), workArea.x),
    Math.max(workArea.x, workArea.x + workArea.width - resolvedWidth),
  );
  const resolvedY = Math.min(
    Math.max(Math.round(y), workArea.y),
    Math.max(workArea.y, workArea.y + workArea.height - resolvedHeight),
  );
  return { x: resolvedX, y: resolvedY, width: resolvedWidth, height: resolvedHeight };
}
