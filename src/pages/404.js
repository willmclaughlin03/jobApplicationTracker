import ErrorPage, { ERROR_PAGE_CONTENT } from '../client/components/ErrorPage';

/**
 * Renders the custom not-found page.
 *
 * Purpose: Replace the default Next.js 404 with a branded recovery path back
 * to the dashboard.
 *
 * @returns {JSX.Element} Custom 404 page.
 */
export default function NotFoundPage() {
  return <ErrorPage {...ERROR_PAGE_CONTENT[404]} />;
}
