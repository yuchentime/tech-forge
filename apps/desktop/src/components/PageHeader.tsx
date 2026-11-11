import type { ReactNode } from 'react';

/**
 * Fixed-height navbar shared by every non-chat view.
 *
 * The height must not depend on its children: a title-only header and a header with action buttons
 * would otherwise differ by the button's line box (the original 60 px vs 72 px mismatch). A fixed
 * `h-16` keeps the divider and the content below it at the same position across views; callers pass
 * layout-only classes such as `justify-between` through `className`.
 */
export function PageHeader({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={`flex h-16 shrink-0 items-center gap-4 border-b border-stone-200 bg-white px-5 md:px-8 ${className}`}
    >
      {children}
    </header>
  );
}
