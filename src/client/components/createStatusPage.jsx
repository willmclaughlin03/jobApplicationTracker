import ErrorPage, { ERROR_PAGE_CONTENT } from './ErrorPage';

/**
 * Builds a status-specific page component and matching status setter.
 *
 * Purpose: Keep custom error-page rendering and direct-response status codes
 * tied to the same statusCode so page modules cannot drift by copy/paste.
 *
 * @param {number} statusCode - HTTP status handled by the generated page.
 * @returns {{ getServerSideProps: Function, StatusPage: Function }} Generated page exports.
 */
export function createStatusPage(statusCode) {
  /**
   * Marks direct status-page responses with the matching HTTP status.
   *
   * @param {object} context - Next.js server-side props context.
   * @returns {{ props: object }} Empty page props.
   */
  function getServerSideProps({ res }) {
    if (res) {
      res.statusCode = statusCode;
    }

    return { props: {} };
  }

  /**
   * Renders the generated custom status page.
   *
   * @returns {JSX.Element} Custom status page.
   */
  function StatusPage() {
    return <ErrorPage {...ERROR_PAGE_CONTENT[statusCode]} />;
  }

  return { getServerSideProps, StatusPage };
}
