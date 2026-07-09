import ErrorPage, { ERROR_PAGE_CONTENT } from '../client/components/ErrorPage';

/**
 * Marks direct unavailable-page responses with the matching HTTP status.
 *
 * @param {object} context - Next.js server-side props context.
 * @returns {{ props: object }} Empty page props.
 */
export function getServerSideProps({ res }) {
  if (res) {
    res.statusCode = 503;
  }

  return { props: {} };
}

/**
 * Renders the custom service-unavailable page.
 *
 * Purpose: Show a temporary outage state without leaking infrastructure or
 * dependency details.
 *
 * @returns {JSX.Element} Custom 503 page.
 */
export default function ServiceUnavailablePage() {
  return <ErrorPage {...ERROR_PAGE_CONTENT[503]} />;
}
