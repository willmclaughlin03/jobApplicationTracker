import Head from 'next/head';
import { AuthProvider } from '../client/contexts/AuthContext';
import '../client/styles/globals.css';

export default function App({ Component, pageProps }) {
  return (
    <>
      <Head>
        <title>Job Application Tracker</title>
        <link rel="icon" type="image/png" href="/favicon.png" />
      </Head>
      <AuthProvider>
        <Component {...pageProps} />
      </AuthProvider>
    </>
  );
}