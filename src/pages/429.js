import ErrorPage, { ERROR_PAGE_CONTENT } from '../client/components/ErrorPage';

/**
 * Marks direct rate-limit-page responses with the matching HTTP status.
 *
 * @param {object} context - Next.js server-side props context.
 * @returns {{ props: object }} Empty page props.
 */
export function getServerSideProps({ res }) {
  if (res) {
    res.statusCode = 429;
  }

  return { props: {} };
}

/**
 * Renders the custom rate-limit page.
 *
 * Purpose: Explain throttling in a user-safe way while offering retry and
 * navigation options.
 *
 * @returns {JSX.Element} Custom 429 page.
 */
export default function TooManyRequestsPage() {
  return <ErrorPage {...ERROR_PAGE_CONTENT[429]} />;
}
