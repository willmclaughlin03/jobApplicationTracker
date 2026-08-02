import { useState, useEffect, useCallback } from 'react';
import { Info } from 'lucide-react';
import { TIER_LIMITS, TIERS } from '../../shared/constants/tiers';

const freeLimits = TIER_LIMITS[TIERS.FREE];
const TOOLTIP_ID = 'info-tooltip-content';

export default function InfoTooltip() {
  const [visible, setVisible] = useState(false);

  const close = useCallback(() => setVisible(false), []);

  useEffect(() => {
    if (!visible) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [visible, close]);

  const handleBlurCapture = (e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) {
      setVisible(false);
    }
  };

  return (
    <div
      className="relative"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocusCapture={() => setVisible(true)}
      onBlurCapture={handleBlurCapture}
    >
      <button
        type="button"
        aria-label="Application info"
        aria-expanded={visible}
        aria-describedby={visible ? TOOLTIP_ID : undefined}
        className="dashboard-control dashboard-focus-ring inline-flex h-9 w-9 items-center justify-center rounded-full text-dashboard-muted transition-colors hover:border-dashboard-accent/60 hover:bg-dashboard-surface-hover hover:text-dashboard-text"
      >
        <Info aria-hidden="true" size={17} />
      </button>

      {visible && (
        <div
          id={TOOLTIP_ID}
          role="tooltip"
          className="absolute right-0 top-full z-[70] mt-2 w-[min(18rem,calc(100vw-2rem))] rounded-dashboard-panel border border-dashboard-control-border bg-dashboard-surface-raised p-4 text-sm text-dashboard-muted shadow-xl"
        >
          <div className="mb-3 border-b border-dashboard-line pb-3">
            <p className="mb-1 font-medium text-dashboard-text">Managing Applications</p>
            <ul className="list-disc list-inside space-y-1">
              <li>Choose <span className="font-medium text-dashboard-text">Add Application</span> to create an entry</li>
              <li>On desktop, open a row&apos;s Actions menu to choose Edit or Delete</li>
              <li>On mobile, use the direct Edit and Delete controls</li>
            </ul>
          </div>

          <div className="mb-3 border-b border-dashboard-line pb-3">
            <p className="mb-1 font-medium text-dashboard-text">Limits</p>
            <ul className="list-disc list-inside space-y-1">
              <li>Max {freeLimits.storage.maxJobs} saved jobs</li>
              <li>Up to {freeLimits.insert.hourly} new jobs per hour</li>
            </ul>
          </div>

          <div>
            <p className="mb-1 font-medium text-dashboard-text">Support</p>
            <p>Found a bug or having an issue? Reach out at{' '}
              <a href="mailto:tracktheapp.support@gmail.com" className="font-medium text-dashboard-accent-hover hover:underline">tracktheapp.support@gmail.com</a>.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
