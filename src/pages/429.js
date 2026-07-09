import { createStatusPage } from '../client/components/createStatusPage';

const { getServerSideProps, StatusPage: TooManyRequestsPage } = createStatusPage(429);

export { getServerSideProps };
export default TooManyRequestsPage;
