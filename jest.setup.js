/**
 * Jest setup file
 *
 * Purpose: Configure global test environment settings
 * Runs before each test file
 */

// Set test environment variables
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test-project.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
