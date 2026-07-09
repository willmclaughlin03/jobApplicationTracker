import ErrorPage, { ERROR_PAGE_CONTENT } from '../client/components/ErrorPage';

/**
 * Marks direct bad-gateway-page responses with the matching HTTP status.
 *
 * @param {object} context - Next.js server-side props context.
 * @returns {{ props: object }} Empty page props.
 */
export function getServerSideProps({ res }) {
  if (res) {
    res.statusCode = 502;
  }

  return { props: {} };
}

/**
 * Renders the custom bad-gateway page.
 *
 * Purpose: Provide a safe fallback page for deployment or proxy layers that
 * route temporary upstream failures back into the app.
 *
 * @returns {JSX.Element} Custom 502 page.
 */
export default function BadGatewayPage() {
  return <ErrorPage {...ERROR_PAGE_CONTENT[502]} />;
}
