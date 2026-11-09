import { useMemo, useState } from 'react';

/** Width a viewBox-only document is scaled up to, so a small coordinate space stays legible. */
const MIN_RENDER_WIDTH = 480;

/** Size given to an SVG that declares neither pixel dimensions nor a viewBox. */
const FALLBACK_SIZE = { width: 640, height: 400 };

/** What the renderer needs for one SVG: the data URL plus the size it should occupy. */
interface PreparedSvg {
  dataUrl: string;
  width: number;
  height: number;
}

/**
 * Renders one SVG artifact.
 *
 * The source is handed to the browser as an image, never as live markup: an `<img>` puts SVG into
 * static mode, where scripts do not run, external references are not fetched, and the document has
 * no same-origin access to the window — which matters because `window.teachforge` is reachable from
 * this renderer. `DOMParser` below is also inert; it only reads attributes to pick a display size.
 */
export function SvgArtifact({ content, fileName }: { content: string; fileName: string }) {
  const [failed, setFailed] = useState(false);
  const prepared = useMemo(() => prepareSvg(content), [content]);

  if (failed || !prepared) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-stone-500">这段 SVG 无法显示，已按原文显示。</p>
        <pre className="overflow-x-auto rounded-lg bg-stone-100 p-3 text-xs leading-5 text-stone-800">
          {content}
        </pre>
      </div>
    );
  }

  return (
    <div className="overflow-auto rounded-lg border border-stone-200 bg-white p-3">
      <img
        alt={fileName}
        className="block max-w-none"
        decoding="async"
        height={prepared.height}
        onError={() => setFailed(true)}
        src={prepared.dataUrl}
        width={prepared.width}
      />
    </div>
  );
}

/** Encodes the source as an image data URL and works out the size to draw it at. */
function prepareSvg(source: string): PreparedSvg | null {
  const size = readIntrinsicSize(source);
  if (!size) return null;
  const bytes = new TextEncoder().encode(source);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return {
    dataUrl: `data:image/svg+xml;base64,${btoa(binary)}`,
    width: size.width,
    height: size.height,
  };
}

/**
 * Reads the size an SVG should be drawn at.
 *
 * Pixel `width`/`height` attributes win; otherwise the `viewBox` is used, scaled up to
 * `MIN_RENDER_WIDTH` when the coordinate space is small so labels are not drawn at 2 px.
 */
function readIntrinsicSize(source: string): { width: number; height: number } | null {
  const document = new DOMParser().parseFromString(source, 'image/svg+xml');
  if (document.querySelector('parsererror')) return null;
  const root = document.documentElement;
  if (!root || root.tagName.toLowerCase() !== 'svg') return null;

  const widthPx = readPixelLength(root.getAttribute('width'));
  const heightPx = readPixelLength(root.getAttribute('height'));
  if (widthPx && heightPx) return { width: Math.round(widthPx), height: Math.round(heightPx) };

  const viewBox = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  if (viewBox.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0) {
    const scale = viewBox[2] >= MIN_RENDER_WIDTH ? 1 : MIN_RENDER_WIDTH / viewBox[2];
    return { width: Math.round(viewBox[2] * scale), height: Math.round(viewBox[3] * scale) };
  }

  // Only one pixel dimension, or relative units: there is no ratio to work with, so use a fixed box.
  return { ...FALLBACK_SIZE };
}

/** Parses `12`, `12.5` or `12px`; every relative unit is rejected because it needs a viewport. */
function readPixelLength(value: string | null): number | null {
  if (!value) return null;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(?:px)?$/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
