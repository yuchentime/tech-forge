/**
 * Decorative sidebar scenery: a lavender dusk with a flag on the far peak.
 *
 * It carries the "learning is a journey" mood behind the conversation list, so it is purely
 * ornamental — hidden from assistive tech, not interactive, and rendered with theme variables so it
 * retints with the skin. It sits absolutely at the bottom of the sidebar and fades to transparent at
 * its top edge, so list rows stay readable wherever it shows through.
 */
export function SidebarScenery() {
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 bottom-0 h-40 w-full select-none"
      fill="none"
      preserveAspectRatio="none"
      viewBox="0 0 240 160"
    >
      <defs>
        <linearGradient id="tf-sidebar-fade" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--color-brand-50)" stopOpacity="0" />
          <stop offset="45%" stopColor="var(--color-brand-50)" stopOpacity="0.55" />
          <stop offset="100%" stopColor="var(--color-brand-100)" stopOpacity="0.9" />
        </linearGradient>
      </defs>
      <rect fill="url(#tf-sidebar-fade)" height="160" width="240" />

      {/* Far ridge and its snow-lit peak, then the near ridge overlapping it. */}
      <path
        d="M0 132 L46 74 L74 104 L104 58 L152 132 Z"
        fill="var(--color-brand-200)"
        opacity="0.75"
      />
      <path
        d="M0 160 L0 138 L62 100 L120 148 L170 116 L240 156 L240 160 Z"
        fill="var(--color-brand-300)"
        opacity="0.7"
      />

      {/* Winding trail up to the flag: the smallest possible "path to mastery" cue. */}
      <path
        d="M104 68 C96 88 118 96 106 112 C96 126 112 132 100 146"
        stroke="var(--color-ink-50)"
        strokeLinecap="round"
        strokeWidth="3"
        opacity="0.85"
      />

      {/* Flag on the summit. */}
      <path d="M104 58 L104 34" stroke="var(--color-brand-700)" strokeLinecap="round" strokeWidth="2" />
      <path d="M104 35 L124 41 L104 48 Z" fill="var(--color-honey-300)" />

      {/* Clouds drifting across the ridge line. */}
      <g fill="var(--color-ink-50)" opacity="0.9">
        <ellipse cx="34" cy="128" rx="26" ry="10" />
        <ellipse cx="54" cy="122" rx="16" ry="8" />
        <ellipse cx="196" cy="132" rx="30" ry="11" />
        <ellipse cx="176" cy="126" rx="15" ry="7" />
      </g>

      {/* Two slow twinkles keep the panel from feeling static. */}
      <g className="tf-twinkle" fill="var(--color-honey-300)">
        <path d="M158 64 l2.2 5.4 5.4 2.2 -5.4 2.2 -2.2 5.4 -2.2 -5.4 -5.4 -2.2 5.4 -2.2 Z" />
      </g>
      <g className="tf-twinkle" fill="var(--color-brand-300)" style={{ animationDelay: '1.4s' }}>
        <path d="M206 82 l1.8 4.4 4.4 1.8 -4.4 1.8 -1.8 4.4 -1.8 -4.4 -4.4 -1.8 4.4 -1.8 Z" />
      </g>
    </svg>
  );
}
