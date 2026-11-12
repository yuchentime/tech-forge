import type { Icon } from '@phosphor-icons/react';

/**
 * First-run placeholder shared by every view that can legitimately hold nothing yet.
 *
 * The recipe is the chat first screen: one filled `brand-400` icon, a title, two lines of
 * explanation and one example line, all sitting directly on the canvas — no card, border, shadow or
 * pill background, so the block never reads as a second panel above the content. Callers own vertical
 * placement through `className` (usually `my-auto` inside a flex column) and supply copy that states
 * what the empty view will eventually contain, not just that it is empty.
 */
export function EmptyState({
  icon: IconComponent,
  title,
  description,
  hint,
  className = '',
}: {
  icon: Icon;
  title: string;
  description: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div className={`tf-rise px-6 text-center ${className}`}>
      <IconComponent aria-hidden="true" className="mx-auto h-9 w-9 text-brand-400" weight="fill" />
      <p className="mt-4 text-xl font-semibold tracking-tight text-ink-900">{title}</p>
      <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-ink-500">{description}</p>
      {hint && <p className="mt-5 text-xs leading-5 text-ink-500">{hint}</p>}
    </div>
  );
}
