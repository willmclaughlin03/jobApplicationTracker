import ErrorPage, { ERROR_PAGE_CONTENT } from '../client/components/ErrorPage';

/**
 * Marks direct forbidden-page responses with the matching HTTP status.
 *
 * @param {object} context - Next.js server-side props context.
 * @returns {{ props: object }} Empty page props.
 */
export function getServerSideProps({ res }) {
  if (res) {
    res.statusCode = 403;
  }

  return { props: {} };
}

/**
 * Renders the custom forbidden page.
 *
 * Purpose: Give users a secure, vague access-denied state without exposing
 * authorization internals or account metadata.
 *
 * @returns {JSX.Element} Custom 403 page.
 */
export default function ForbiddenPage() {
  return <ErrorPage {...ERROR_PAGE_CONTENT[403]} />;
}
