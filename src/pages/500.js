import ErrorPage, { ERROR_PAGE_CONTENT } from '../client/components/ErrorPage';

/**
 * Renders the custom internal-error page.
 *
 * Purpose: Replace default server-error output with public-safe copy that does
 * not disclose stack traces or service details.
 *
 * @returns {JSX.Element} Custom 500 page.
 */
export default function InternalServerErrorPage() {
  return <ErrorPage {...ERROR_PAGE_CONTENT[500]} />;
}
