import Head from 'next/head';
import { useRouter } from 'next/router';
import { ERROR_STATUS_CODES } from '../../shared/constants/errorStatusCodes';

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

      <main className="min-h-screen bg-gray-100 px-5 py-10 flex items-center justify-center">
        <section
          aria-labelledby="error-page-title"
          className="w-full max-w-lg bg-white border border-gray-200 rounded-lg shadow-sm px-7 py-8 text-center"
        >
          <img
            src="/favicon.png"
            alt=""
            aria-hidden="true"
            className="mx-auto mb-5 h-12 w-12"
          />

          <p className="text-sm font-semibold text-blue-600 mb-2">{statusCode}</p>
          <h1 id="error-page-title" className="text-2xl font-semibold text-gray-900 mb-3">
            {title}
          </h1>
          <p className="text-sm text-gray-600 leading-6">{description}</p>
          <p className="text-sm text-gray-500 leading-6 mt-2">{guidance}</p>

          <div className="mt-7 flex flex-col sm:flex-row items-stretch sm:items-center justify-center gap-3">
            <a
              href={primaryHref}
              className="inline-flex items-center justify-center rounded-md bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
            >
              {primaryLabel}
            </a>
            <button
              type="button"
              onClick={handleBack}
              className="inline-flex items-center justify-center rounded-md border border-gray-300 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Back
            </button>
            {showRetry && (
              <button
                type="button"
                onClick={handleRetry}
                className="inline-flex items-center justify-center rounded-md border border-gray-300 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
              >
                Try again
              </button>
            )}
          </div>
        </section>
      </main>
    </>
  );
}
