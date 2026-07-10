import { createStatusPage } from '../client/components/createStatusPage';

const { getServerSideProps, StatusPage: ForbiddenPage } = createStatusPage(403);

export { getServerSideProps };
export default ForbiddenPage;
