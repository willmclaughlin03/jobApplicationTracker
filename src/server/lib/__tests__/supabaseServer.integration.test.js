// lib/__tests__/supabaseServer.integration.test.js

/**
 * Integration tests for supabaseServer.js
 *
 * Purpose: Test authentication against real Supabase instance
 * Requires: TEST_SUPABASE_URL, TEST_SUPABASE_SERVICE_KEY,
 *           SUPABASE_TEST_PROJECT_REF env vars
 *
 * Run with: npm run test:integration
 *
 * Creates a disposable test user via admin API, generates a magic link OTP,
 * and exchanges it for a session to obtain a real access token — no email
 * provider required.
 */

const { createClient } = require('@supabase/supabase-js');
const {
  SUPABASE_TEST_PROJECT_REF_ENV_NAME,
  TEST_SUPABASE_ENV_NAMES,
  matchesSupabaseTestProject,
} = require('../../../testSupport/integrationEnvironment.js');

// Skip unless credentials exist and target the isolated Supabase test project.
const TEST_URL = process.env[TEST_SUPABASE_ENV_NAMES.url];
const TEST_SERVICE_KEY = process.env[TEST_SUPABASE_ENV_NAMES.serviceKey];
const TEST_PROJECT_REF = process.env[SUPABASE_TEST_PROJECT_REF_ENV_NAME];
const SKIP_INTEGRATION =
  !TEST_URL ||
  !TEST_SERVICE_KEY ||
  !matchesSupabaseTestProject(TEST_URL, TEST_PROJECT_REF);

// Create a test client (separate from the main app client)
const testSupabase = SKIP_INTEGRATION
  ? null
  : createClient(
      TEST_URL,
      TEST_SERVICE_KEY
    );

describe('supabaseServer integration tests', () => {
  let validToken;
  let testUserId;
  const testEmail = `supabase-test-${Date.now()}@integration-test.local`;

  beforeAll(async () => {
    if (SKIP_INTEGRATION) {
      console.warn('Skipping integration tests: isolated Supabase test environment is not configured');
      return;
    }

    // Create a disposable test user via admin API
    const { data: userData, error: createError } = await testSupabase.auth.admin.createUser({
      email: testEmail,
      email_confirm: true,
    });
    if (createError) throw new Error(`Test user creation failed: ${createError.message}`);
    testUserId = userData.user.id;

    // Generate a magic link OTP and exchange it for a session to get an access token
    const { data: linkData, error: linkError } = await testSupabase.auth.admin.generateLink({
      type: 'magiclink',
      email: testEmail,
    });
    if (linkError) throw new Error(`Magic link generation failed: ${linkError.message}`);

    const { data: sessionData, error: otpError } = await testSupabase.auth.verifyOtp({
      email: testEmail,
      token: linkData.properties.email_otp,
      type: 'email',
    });
    if (otpError) throw new Error(`OTP verification failed: ${otpError.message}`);
    validToken = sessionData.session.access_token;
  });

  afterAll(async () => {
    if (!SKIP_INTEGRATION && testUserId) {
      await testSupabase.auth.admin.deleteUser(testUserId);
    }
  });

  // Conditionally skip all tests unless the isolated test project is configured.
  const testFn = SKIP_INTEGRATION ? it.skip : it;

  describe('token validation against real Supabase', () => {
    testFn('should validate a real JWT token', async () => {
      const { data, error } = await testSupabase.auth.getUser(validToken);

      expect(error).toBeNull();
      expect(data.user).not.toBeNull();
      expect(data.user.email).toBe(testEmail);
    });

    testFn('should reject an invalid token', async () => {
      const { data, error } = await testSupabase.auth.getUser('invalid-token');

      expect(data.user).toBeNull();
      expect(error).not.toBeNull();
    });

    testFn('should reject an expired token', async () => {
      // This is a structurally valid but expired/invalid JWT
      const expiredToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwiZXhwIjoxfQ.invalid';

      const { data, error } = await testSupabase.auth.getUser(expiredToken);

      expect(data.user).toBeNull();
      expect(error).not.toBeNull();
    });

    testFn('should return correct user metadata', async () => {
      const { data } = await testSupabase.auth.getUser(validToken);

      expect(data.user).toMatchObject({
        email: testEmail,
        aud: 'authenticated',
        role: 'authenticated',
      });
      expect(data.user.id).toBeDefined();
      expect(data.user.created_at).toBeDefined();
    });
  });

  describe('full request flow simulation', () => {
    testFn('should authenticate a simulated API request', async () => {
      // Simulate what happens in your actual API routes
      const mockReq = {
        headers: {
          authorization: `Bearer ${validToken}`,
        },
      };

      // Extract token like your middleware does
      const authHeader = mockReq.headers.authorization;
      const token = authHeader.substring(7);

      const { data, error } = await testSupabase.auth.getUser(token);

      expect(error).toBeNull();
      expect(data.user.email).toBe(testEmail);
    });
  });
});
