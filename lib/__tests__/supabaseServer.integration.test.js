// lib/__tests__/supabaseServer.integration.test.js

/**
 * Integration tests for supabaseServer.js
 * 
 * Purpose: Test authentication against real Supabase instance
 * Requires: TEST_SUPABASE_URL, TEST_SUPABASE_SERVICE_KEY, 
 *           TEST_USER_EMAIL, TEST_USER_PASSWORD env vars
 * 
 * Run with: npm run test:integration
 */

const { createClient } = require('@supabase/supabase-js');

// Skip if test environment variables aren't set
const SKIP_INTEGRATION = !process.env.NEXT_PUBLIC_SUPABASE_URL 
  

// Create a test client (separate from the main app client)
const testSupabase = SKIP_INTEGRATION 
  ? null 
  : createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

// We need to dynamically require the module with test env vars
// or create test-specific functions
async function getTestUserToken() {
  const { data, error } = await testSupabase.auth.signInWithPassword({
    email: process.env.TEST_USER_EMAIL,
    password: process.env.TEST_USER_PASSWORD,
  });
  
  if (error) throw new Error(`Failed to get test token: ${error.message}`);
  return data.session.access_token;
}

describe('supabaseServer integration tests', () => {
  let validToken;

  beforeAll(async () => {
    if (SKIP_INTEGRATION) {
      console.warn('Skipping integration tests: TEST_SUPABASE_URL not set');
      return;
    }
    
    // Get a valid token for testing
    validToken = await getTestUserToken();
  });

  // Conditionally skip all tests if env vars not set
  const testFn = SKIP_INTEGRATION ? it.skip : it;

  describe('token validation against real Supabase', () => {
    testFn('should validate a real JWT token', async () => {
      const { data, error } = await testSupabase.auth.getUser(validToken);
      
      expect(error).toBeNull();
      expect(data.user).not.toBeNull();
      expect(data.user.email).toBe(process.env.TEST_USER_EMAIL);
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
        email: process.env.TEST_USER_EMAIL,
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
      expect(data.user.email).toBe(process.env.TEST_USER_EMAIL);
    });
  });
});
