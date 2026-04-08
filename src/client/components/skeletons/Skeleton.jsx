/**
 * Generic pulse-block primitive used to compose skeleton loading states.
 *
 * Purpose: Render a neutral, animated placeholder that mirrors the shape of
 * real content while data is loading. Intentionally minimal so it can be
 * sized/shaped by consumers via Tailwind className overrides.
 *
 * Usage: <Skeleton className="h-4 w-24" />
 *
 * @param {string} className - Tailwind classes for sizing/shape overrides
 */
export default function Skeleton({ className = '' }) {
  return (
    <div
      className={`animate-pulse bg-gray-200 rounded ${className}`}
      aria-hidden="true"
    />
  );
}
