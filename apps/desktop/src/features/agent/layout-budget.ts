/**
 * Width budget shared by the chat column and the artifact panel.
 *
 * The panel's width is a stored *preference*, never a layout fact: every render derives the real
 * width from the space that is available, so a narrow window cannot rewrite what the user chose.
 * The window itself is the only elastic resource; this module decides how much width the layout
 * needs so the main process can grow the window to exactly that point.
 */

/** Fixed width of the left conversation rail (`md:w-64`); the panel and chat share what is left. */
export const LEFT_RAIL_WIDTH = 256;

/** Horizontal padding of the chat column (`md:px-8`, both sides). */
export const CHAT_GUTTER_WIDTH = 64;

/** Comfortable chat column: 560px of body text (about 38 CJK characters at 14px). */
export const CHAT_COLUMN_COMFORT = 560 + CHAT_GUTTER_WIDTH;

/** Smallest chat column still worth reading: 432px of body text (about 31 CJK characters). */
export const CHAT_COLUMN_FLOOR = 432 + CHAT_GUTTER_WIDTH;

/** Narrowest usable preview; Markdown and SVG stay legible without horizontal squeezing. */
export const PANEL_MIN_WIDTH = 320;

/** Widest preview the panel may take, independent of how much screen is available. */
export const PANEL_MAX_WIDTH = 900;

/** Default width for a user who has never dragged the panel. */
export const PANEL_DEFAULT_WIDTH = 384;

/** Below this viewport the panel stacks under the chat instead of sitting beside it. */
export const STACKED_BREAKPOINT = 768;

/** Narrowest content width that can still show chat and panel side by side. */
export const SPLIT_MIN_CONTENT_WIDTH =
  LEFT_RAIL_WIDTH + CHAT_COLUMN_FLOOR + PANEL_MIN_WIDTH;

export type ArtifactLayoutMode = 'stacked' | 'split' | 'overlay';

export type ArtifactLayoutPlan = {
  mode: ArtifactLayoutMode;
  /** Width the panel renders at in this plan (already clamped to the available budget). */
  panelWidth: number;
  /** Width left for the chat column after the panel takes its share. */
  chatColumnWidth: number;
  /** Window content width this plan needs; the caller requests growth toward it. */
  requiredContentWidth: number;
  /** True when `requiredContentWidth` exceeds the current window content width. */
  needsGrowth: boolean;
};

export type ArtifactLayoutInput = {
  /** `window.innerWidth`: content width of the window right now. */
  viewportContentWidth: number;
  /** The user's stored panel width, which may not fit right now. */
  requestedPanelWidth: number;
  /**
   * Widest content width the display can give the window, reported by the main process after a
   * growth request. `null` before the first reply: the layout then assumes growth still works.
   */
  maxContentWidth: number | null;
};

/** Clamps a stored or dragged width to the supported panel range. */
export function clampPanelWidth(value: number): number {
  if (!Number.isFinite(value)) return PANEL_DEFAULT_WIDTH;
  return Math.min(Math.max(Math.round(value), PANEL_MIN_WIDTH), PANEL_MAX_WIDTH);
}

/**
 * Plans how the panel and the chat column share the window.
 *
 * Order of concessions: the window grows first (reported through `needsGrowth`), then the panel
 * narrows down to its minimum while the chat keeps the floor, and only when even that does not
 * fit does the panel float over the chat instead of squeezing it.
 */
export function planArtifactLayout(
  input: ArtifactLayoutInput,
): ArtifactLayoutPlan {
  const viewport = Math.max(0, Math.floor(input.viewportContentWidth));
  const requested = clampPanelWidth(input.requestedPanelWidth);

  if (viewport < STACKED_BREAKPOINT) {
    return {
      mode: 'stacked',
      panelWidth: requested,
      chatColumnWidth: viewport,
      requiredContentWidth: viewport,
      needsGrowth: false,
    };
  }

  const limit =
    input.maxContentWidth === null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Math.floor(input.maxContentWidth));
  /** Space for the chat column and the panel once the rail has taken its fixed width. */
  const shareable = limit - LEFT_RAIL_WIDTH;
  const comfortNeed = LEFT_RAIL_WIDTH + CHAT_COLUMN_COMFORT + requested;

  if (comfortNeed <= limit) {
    return {
      mode: 'split',
      panelWidth: requested,
      chatColumnWidth: Math.max(0, viewport - LEFT_RAIL_WIDTH - requested),
      requiredContentWidth: comfortNeed,
      needsGrowth: comfortNeed > viewport,
    };
  }

  const panelWidth = Math.min(
    Math.max(
      Math.min(requested, shareable - CHAT_COLUMN_FLOOR),
      PANEL_MIN_WIDTH,
    ),
    PANEL_MAX_WIDTH,
  );
  const chatColumnWidth = shareable - panelWidth;

  if (chatColumnWidth >= CHAT_COLUMN_FLOOR) {
    const required = LEFT_RAIL_WIDTH + chatColumnWidth + panelWidth;
    return {
      mode: 'split',
      panelWidth,
      chatColumnWidth,
      requiredContentWidth: required,
      needsGrowth: required > viewport,
    };
  }

  // Even the minimum panel cannot coexist with a readable chat column: float it over the chat and
  // keep the conversation at full width instead of squeezing both.
  const overlayChatColumn = Math.max(0, viewport - LEFT_RAIL_WIDTH);
  return {
    mode: 'overlay',
    panelWidth: Math.min(
      requested,
      Math.max(PANEL_MIN_WIDTH, overlayChatColumn - PANEL_MIN_WIDTH),
    ),
    chatColumnWidth: overlayChatColumn,
    requiredContentWidth: viewport,
    needsGrowth: false,
  };
}
