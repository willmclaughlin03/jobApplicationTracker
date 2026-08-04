/**
 * Generic pulse-block primitive used to compose skeleton loading states.
 *
 * Purpose: Render an emerald-dashboard placeholder that mirrors the shape of
 * real content while data is loading. Intentionally minimal so consumers can
 * size and shape it through Tailwind className overrides.
 *
 * Usage: <Skeleton className="h-4 w-24" />
 *
 * @param {string} className - Tailwind classes for sizing/shape overrides
 */
export default function Skeleton({ className = '' }) {
  return (
    <div
      className={`dashboard-motion animate-pulse rounded bg-dashboard-surface-hover/80 ${className}`}
      aria-hidden="true"
    />
  );
}
