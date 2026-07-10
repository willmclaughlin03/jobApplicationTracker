import { createStatusPage } from '../client/components/createStatusPage';

const { getServerSideProps, StatusPage: GatewayTimeoutPage } = createStatusPage(504);

export { getServerSideProps };
export default GatewayTimeoutPage;
