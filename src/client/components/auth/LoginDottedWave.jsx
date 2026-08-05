/**
 * Render the login page's static dotted emerald wave.
 *
 * Purpose: Recreates the supplied reference's lower-canvas visual weight with
 * responsive vector geometry instead of a raster screenshot, remote asset, or
 * animated particle effect. The artwork is decorative and never interactive.
 *
 * @returns {React.ReactElement} Accessibility-hidden responsive wave artwork.
 */
export default function LoginDottedWave() {
  return (
    <svg
      data-testid="login-dotted-wave"
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 720 300"
      preserveAspectRatio="xMidYMax slice"
      className="login-dotted-wave text-dashboard-accent"
    >
      <defs>
        <pattern
          id="login-wave-dot-grid"
          width="10"
          height="10"
          patternUnits="userSpaceOnUse"
        >
          <circle cx="1.5" cy="1.5" r="1.15" fill="currentColor" />
        </pattern>
        <linearGradient id="login-wave-fade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="white" stopOpacity="0" />
          <stop offset="0.18" stopColor="white" stopOpacity="0.8" />
          <stop offset="0.76" stopColor="white" stopOpacity="1" />
          <stop offset="1" stopColor="white" stopOpacity="0.15" />
        </linearGradient>
        <mask id="login-wave-opacity-mask">
          <rect width="720" height="300" fill="url(#login-wave-fade)" />
        </mask>
      </defs>

      <g mask="url(#login-wave-opacity-mask)">
        <path
          d="M-50 253C72 199 151 213 244 174C340 134 409 67 514 77C607 86 674 64 770 18V330H-50Z"
          fill="url(#login-wave-dot-grid)"
          opacity="0.34"
        />
        <path
          d="M-70 294C53 231 148 244 252 203C359 160 424 98 523 108C621 118 692 94 790 51V330H-70Z"
          fill="url(#login-wave-dot-grid)"
          opacity="0.24"
          transform="translate(3 -2)"
        />
        <path
          d="M-85 324C47 267 145 281 265 239C373 201 452 142 555 151C650 159 712 138 805 101V350H-85Z"
          fill="url(#login-wave-dot-grid)"
          opacity="0.16"
          transform="translate(-2 1)"
        />
        <path
          d="M-40 254C74 201 151 214 244 175C341 134 410 69 514 78C608 87 675 65 760 25"
          fill="none"
          stroke="currentColor"
          strokeWidth="0.9"
          strokeDasharray="1 8"
          strokeLinecap="round"
          opacity="0.42"
        />
      </g>
    </svg>
  );
}
