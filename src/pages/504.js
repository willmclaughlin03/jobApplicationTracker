import ErrorPage, { ERROR_PAGE_CONTENT } from '../client/components/ErrorPage';

/**
 * Marks direct timeout-page responses with the matching HTTP status.
 *
 * @param {object} context - Next.js server-side props context.
 * @returns {{ props: object }} Empty page props.
 */
export function getServerSideProps({ res }) {
  if (res) {
    res.statusCode = 504;
  }

  return { props: {} };
}

/**
 * Renders the custom gateway-timeout page.
 *
 * Purpose: Give users a safe recovery path when a request takes too long.
 *
 * @returns {JSX.Element} Custom 504 page.
 */
export default function GatewayTimeoutPage() {
  return <ErrorPage {...ERROR_PAGE_CONTENT[504]} />;
}
