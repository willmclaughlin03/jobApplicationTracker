import { createStatusPage } from '../client/components/createStatusPage';

const { getServerSideProps, StatusPage: BadGatewayPage } = createStatusPage(502);

export { getServerSideProps };
export default BadGatewayPage;
