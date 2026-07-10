import { createStatusPage } from '../client/components/createStatusPage';

const { StatusPage: InternalServerErrorPage } = createStatusPage(500);

export default InternalServerErrorPage;
