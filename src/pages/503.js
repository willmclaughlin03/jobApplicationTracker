import { createStatusPage } from '../client/components/createStatusPage';

const { getServerSideProps, StatusPage: ServiceUnavailablePage } = createStatusPage(503);

export { getServerSideProps };
export default ServiceUnavailablePage;
