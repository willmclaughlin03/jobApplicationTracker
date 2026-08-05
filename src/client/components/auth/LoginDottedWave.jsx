const WAVE_STRAND_COUNT = 22;

/**
 * Build one depth row in the login particle mesh.
 *
 * Purpose: Varies the curve, opacity, and dot phase by row so the inexpensive
 * static SVG reads as a dimensional particle surface at any viewport ratio.
 *
 * @param {number} rowIndex - Zero-based row within the particle surface.
 * @returns {{d: string, opacity: number, dashOffset: number}} Strand presentation data.
 */
function createWaveStrand(rowIndex) {
  const depth = rowIndex / (WAVE_STRAND_COUNT - 1);
  const leftY = 70 + (44 * depth);
  const leftLiftY = 62 + (44 * depth);
  const leftValleyY = 77 + (38 * depth);
  const shoulderY = 63 + (42 * depth);
  const centerLiftY = 50 + (46 * depth);
  const crestY = 27 + (55 * depth);
  const crestFallY = 34 + (53 * depth);
  const rightValleyY = 44 + (50 * depth);
  const rightLiftY = 47 + (50 * depth);
  const rightY = 30 + (64 * depth);
  const opacity = 0.16 + (Math.sin(Math.PI * depth) * 0.34) + (depth * 0.08);

  return {
    d: [
      'M -8 ' + leftY.toFixed(2),
      'C 7 ' + leftLiftY.toFixed(2) + ' 19 ' + leftValleyY.toFixed(2) + ' 34 ' + shoulderY.toFixed(2),
      'C 47 ' + centerLiftY.toFixed(2) + ' 55 ' + crestY.toFixed(2) + ' 68 ' + crestFallY.toFixed(2),
      'C 80 ' + rightValleyY.toFixed(2) + ' 89 ' + rightLiftY.toFixed(2) + ' 108 ' + rightY.toFixed(2),
    ].join(' '),
    opacity: Number(opacity.toFixed(2)),
    dashOffset: Number(((rowIndex * 2.35) % 12).toFixed(2)),
  };
}

const WAVE_STRANDS = Array.from(
  { length: WAVE_STRAND_COUNT },
  (_, rowIndex) => createWaveStrand(rowIndex),
);

/**
 * Render the login page's static dotted emerald particle wave.
 *
 * Purpose: Recreates the supplied reference's lower-canvas visual weight with
 * responsive vector geometry instead of a raster screenshot, remote asset, or
 * animated effect. The artwork is decorative and never interactive.
 *
 * @returns {React.ReactElement} Accessibility-hidden responsive wave artwork.
 */
export default function LoginDottedWave() {
  return (
    <svg
      data-testid="login-dotted-wave"
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className="login-dotted-wave text-dashboard-accent"
    >
      <defs>
        <linearGradient id="login-wave-fade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="white" stopOpacity="0" />
          <stop offset="0.12" stopColor="white" stopOpacity="0.18" />
          <stop offset="0.3" stopColor="white" stopOpacity="0.78" />
          <stop offset="0.62" stopColor="white" stopOpacity="1" />
          <stop offset="0.9" stopColor="white" stopOpacity="0.72" />
          <stop offset="1" stopColor="white" stopOpacity="0.08" />
        </linearGradient>
        <mask id="login-wave-opacity-mask">
          <rect width="100" height="100" fill="url(#login-wave-fade)" />
        </mask>
      </defs>

      <g mask="url(#login-wave-opacity-mask)">
        {WAVE_STRANDS.map((strand, rowIndex) => (
          <path
            key={rowIndex}
            data-wave-strand="true"
            d={strand.d}
            fill="none"
            stroke="currentColor"
            strokeDashoffset={strand.dashOffset}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            opacity={strand.opacity}
            className="login-wave-strand"
          />
        ))}
      </g>
    </svg>
  );
}
