/**
 * Terminal auth-session unavailable state for guarded pages.
 *
 * Purpose: replace an endless initial auth spinner when /api/auth/session
 * remains unavailable or rate-limited after bounded recovery attempts.
 *
 * @param {Object} props - Component props
 * @param {{ code?: string, retryAfterSeconds?: number|null }|null} props.sessionError - Auth session error state
 * @param {Function} props.onRetry - Starts a fresh session check
 * @returns {JSX.Element}
 */
export default function AuthSessionUnavailable({ sessionError, onRetry }) {
  const isRateLimited = sessionError?.code === 'SESSION_RATE_LIMITED';
  const retryAfterSeconds = sessionError?.retryAfterSeconds;
  const retryAfterText = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
    ? ` Try again in about ${Math.ceil(retryAfterSeconds / 60)} minute${Math.ceil(retryAfterSeconds / 60) === 1 ? '' : 's'}.`
    : '';

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100 px-5">
      <div className="w-full max-w-md bg-white border border-gray-200 rounded-lg shadow-sm p-6 text-center">
        <h1 className="text-xl font-semibold text-gray-800 mb-2">
          {isRateLimited ? 'Session check paused' : 'Session check unavailable'}
        </h1>
        <p className="text-sm text-gray-600 mb-5">
          {isRateLimited
            ? `Too many session checks are in progress.${retryAfterText}`
            : 'The server could not confirm your session. Your account access has not changed.'}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center justify-center rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-gray-400 focus:ring-offset-2"
        >
          Retry
        </button>
      </div>
    </div>
  );
}
