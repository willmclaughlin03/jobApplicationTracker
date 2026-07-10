import ErrorPage, { getErrorPageContent } from '../client/components/ErrorPage';
import { logger } from '../shared/logger.js';

/**
 * Resolves the HTTP status code provided by Next.js for framework errors.
 *
 * Purpose: Prefer the response status when present, fall back to thrown error
 * metadata, and otherwise use the secure generic 500 page.
 *
 * @param {object|null|undefined} res - Next.js response context.
 * @param {object|null|undefined} err - Thrown page error context.
 * @returns {number} Status code for safe error-page mapping.
 */
function resolveStatusCode(res, err) {
  if (Number.isInteger(res?.statusCode)) {
    return res.statusCode;
  }

  if (Number.isInteger(err?.statusCode)) {
    return err.statusCode;
  }

  return 500;
}

/**
 * Renders the catch-all Next.js error page.
 *
 * Purpose: Route unknown page failures through the same secure error UI while
 * ignoring raw exception messages in rendered output.
 *
 * @param {object} props - Next.js error page props.
 * @param {number} props.statusCode - HTTP status to display.
 * @returns {JSX.Element} Custom framework error page.
 */
export default function NextErrorPage({ statusCode }) {
  return <ErrorPage {...getErrorPageContent(statusCode)} />;
}

/**
 * Supplies only the status code needed to render a public-safe error page.
 *
 * @param {object} context - Next.js error context.
 * @returns {{ statusCode: number }} Error page props.
 */
NextErrorPage.getInitialProps = function getInitialProps({ res, err }) {
  const statusCode = resolveStatusCode(res, err);

  if (typeof window === 'undefined' && err) {
    logger.error({ err, statusCode }, 'Unhandled page error');
  }

  return {
    statusCode,
  };
};
