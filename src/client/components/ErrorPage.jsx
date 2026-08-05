import Head from 'next/head';
import { useRouter } from 'next/router';
import { ArrowRight } from 'lucide-react';
import { ERROR_STATUS_CODES } from '../../shared/constants/errorStatusCodes';
import PublicPageShell, {
  PUBLIC_PRIMARY_ACTION_CLASS_NAME,
} from './public/PublicPageShell';

export { ERROR_STATUS_CODES };

const ERROR_STATUS_CODE_SET = new Set(ERROR_STATUS_CODES);

export const ERROR_PAGE_CONTENT = {
  403: {
    statusCode: 403,
    title: 'Access is restricted',
    description: 'This area is not available for your account.',
    guidance: 'Return to a working page or sign in with an account that has access.',
    primaryLabel: 'Go to dashboard',
    primaryHref: '/',
    showRetry: false,
  },
  404: {
    statusCode: 404,
    title: 'Page not found',
    description: 'We could not find the page you were looking for.',
    guidance: 'The link may be outdated, or the page may have moved.',
    primaryLabel: 'Go to dashboard',
    primaryHref: '/',
    showRetry: false,
  },
  429: {
    statusCode: 429,
    title: 'Too many requests',
    description: 'Too many requests reached us in a short window.',
    guidance: 'Please wait a moment, then try again.',
    primaryLabel: 'Go to dashboard',
    primaryHref: '/',
    showRetry: true,
  },
  500: {
    statusCode: 500,
    title: 'Something went wrong',
    description: 'Track The App could not complete that request.',
    guidance: 'Please try again or return to a working page.',
    primaryLabel: 'Go to dashboard',
    primaryHref: '/',
    showRetry: true,
  },
  502: {
    statusCode: 502,
    title: 'Temporary connection issue',
    description: 'A temporary connection issue interrupted the request.',
    guidance: 'Please try again shortly.',
    primaryLabel: 'Go to dashboard',
    primaryHref: '/',
    showRetry: true,
  },
  503: {
    statusCode: 503,
    title: 'Service temporarily unavailable',
    description: 'Track The App is temporarily unavailable.',
    guidance: 'Please wait a moment and try again.',
    primaryLabel: 'Go to dashboard',
    primaryHref: '/',
    showRetry: true,
  },
  504: {
    statusCode: 504,
    title: 'Request timed out',
    description: 'That request took longer than expected.',
    guidance: 'Please try again or return to a working page.',
    primaryLabel: 'Go to dashboard',
    primaryHref: '/',
    showRetry: true,
  },
};

/**
 * Resolves public-safe display copy for a status code.
 *
 * Purpose: Keep page-level and framework-level error rendering on the same
 * vague, non-sensitive content contract without exposing thrown messages.
 *
 * @param {number|string|null|undefined} statusCode - HTTP status from Next.js or a status page.
 * @returns {object} Safe display content for the status code.
 */
export function getErrorPageContent(statusCode) {
  const normalizedStatus = Number(statusCode);

  if (Number.isInteger(normalizedStatus) && ERROR_STATUS_CODE_SET.has(normalizedStatus)) {
    return ERROR_PAGE_CONTENT[normalizedStatus];
  }

  return ERROR_PAGE_CONTENT[500];
}

/**
 * Renders a branded, secure error state for full-page failures.
 *
 * Purpose: Give users a clear way back to the app while avoiding stack traces,
 * backend names, request identifiers, or raw thrown error details.
 *
 * @param {object} props - Public-safe error page content.
 * @returns {JSX.Element} Full-page error UI.
 */
export default function ErrorPage({
  statusCode,
  title,
  description,
  guidance,
  primaryLabel = 'Go to dashboard',
  primaryHref = '/',
  showRetry = false,
}) {
  const router = useRouter();

  /**
   * Sends users back through browser history when a previous working page exists.
   */
  function handleBack() {
    router.back();
  }

  /**
   * Reloads the current page for temporary errors that may resolve on retry.
   */
  function handleRetry() {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  }

  return (
    <>
      <Head>
        <title>{statusCode} - Track The App</title>
        <meta name="robots" content="noindex" />
      </Head>

      <PublicPageShell
        contentTestId="error-page-panel"
        contentClassName="text-center"
      >
        <section
          aria-labelledby="error-page-title"
          className="w-full"
        >
          <p
            data-testid="error-status-code"
            className="text-6xl font-semibold leading-none tracking-tight text-dashboard-accent sm:text-7xl"
          >
            {statusCode}
          </p>
          <h1
            id="error-page-title"
            className="mt-4 text-2xl font-semibold tracking-tight text-dashboard-text sm:text-[1.75rem] sm:leading-9"
          >
            {title}
          </h1>
          <p className="mt-3 text-dashboard-body text-dashboard-muted">{description}</p>
          <p className="mt-1 text-dashboard-caption text-dashboard-muted/90">{guidance}</p>

          <div className="mt-8">
            <a
              href={primaryHref}
              className={[PUBLIC_PRIMARY_ACTION_CLASS_NAME, 'relative justify-center'].join(' ')}
            >
              <span>{primaryLabel}</span>
              <ArrowRight
                aria-hidden="true"
                size={17}
                strokeWidth={1.8}
                className="absolute right-3.5 shrink-0 text-dashboard-accent sm:right-4"
              />
            </a>

            <div className="mt-3 flex min-h-9 items-center justify-center gap-2">
              <button
                type="button"
                onClick={handleBack}
                className="dashboard-focus-ring inline-flex min-h-9 items-center justify-center rounded-dashboard-control px-3 text-dashboard-caption font-medium text-dashboard-muted transition-colors hover:bg-dashboard-surface/55 hover:text-dashboard-text"
              >
                Back
              </button>
              {showRetry && (
                <button
                  type="button"
                  onClick={handleRetry}
                  className="dashboard-focus-ring inline-flex min-h-9 items-center justify-center rounded-dashboard-control px-3 text-dashboard-caption font-medium text-dashboard-muted transition-colors hover:bg-dashboard-surface/55 hover:text-dashboard-text"
                >
                  Try again
                </button>
              )}
            </div>
          </div>
        </section>
      </PublicPageShell>
    </>
  );
}
