/**
 * Animated SVG spinner for loading states
 *
 * @param {'sm'|'md'|'lg'} size - Controls dimensions: sm=12px, md=20px, lg=32px
 * @param {string} className - Additional Tailwind classes (e.g. text color, margin)
 */
export default function Spinner({ size = 'md', className = '' }) {
  const sizes = { sm: 'w-3 h-3', md: 'w-5 h-5', lg: 'w-8 h-8' };
  return (
    <svg
      className={`animate-spin ${sizes[size]} ${className}`}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
