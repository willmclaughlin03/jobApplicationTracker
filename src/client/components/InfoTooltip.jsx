import { useState, useEffect, useCallback } from 'react';
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
        className="w-8 h-8 rounded-full bg-gray-200 text-gray-500 hover:bg-gray-300 hover:text-gray-700 flex items-center justify-center text-sm font-semibold transition-colors"
      >
        i
      </button>

      {visible && (
        <div
          id={TOOLTIP_ID}
          role="tooltip"
          className="absolute right-0 top-full mt-2 w-72 bg-white border border-gray-200 rounded-lg shadow-lg z-50 p-4 text-sm text-gray-600"
        >
          <div className="pb-3 mb-3 border-b border-gray-100">
            <p className="font-medium text-gray-800 mb-1">Managing Jobs</p>
            <ul className="list-disc list-inside space-y-1">
              <li>Click <span className="font-medium text-gray-700">"Add New Job"</span> to create an entry</li>
              <li>Click the edit icon to edit a listing</li>
              <li>Use the delete icon on a row to delete a listing</li>
            </ul>
          </div>

          <div className="pb-3 mb-3 border-b border-gray-100">
            <p className="font-medium text-gray-800 mb-1">Limits</p>
            <ul className="list-disc list-inside space-y-1">
              <li>Max {freeLimits.storage.maxJobs} saved jobs</li>
              <li>Up to {freeLimits.insert.hourly} new jobs per hour</li>
            </ul>
          </div>

          <div className="pb-3 mb-3 border-b border-gray-100">
            <p className="font-medium text-gray-800 mb-1">Change Password</p>
            <p>Click your profile icon in the top-right corner and select "Reset Password".</p>
          </div>

          <div>
            <p className="font-medium text-gray-800 mb-1">Support</p>
            <p>Found a bug or having an issue? Reach out at{' '}
              <a href="mailto:support@example.com" className="text-blue-600 hover:underline">support@example.com</a>.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
