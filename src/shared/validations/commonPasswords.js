/**
 * Common passwords blocklist
 *
 * Purpose: Prevent users from using frequently breached passwords
 * Source: Derived from SecLists and HaveIBeenPwned top passwords
 *
 * Connects to: authSchema.js for password validation
 *
 * Note: All passwords are stored lowercase for case-insensitive matching.
 * This is a curated list of common patterns that meet the 12+ char requirement.
 */
export const COMMON_PASSWORDS = [
  // Classic patterns with numbers
  'password123456',
  'password12345!',
  'password1234!@',
  'password123!@#',
  'qwerty12345678',
  'qwerty123456!',
  'qwertyuiop123',
  'qwertyuiop12!',
  'letmein123456',
  'welcome123456',
  'welcome12345!',
  'admin123456789',
  'admin12345678!',
  'administrator1',
  'changeme123456',
  'changeme12345!',

  // Common phrases
  'iloveyou123456',
  'iloveyou12345!',
  'sunshine123456',
  'princess123456',
  'football123456',
  'baseball123456',
  'basketball1234',
  'trustno1234567',
  'dragon12345678',
  'master12345678',
  'shadow12345678',
  'monkey12345678',
  'letmein1234567',
  'abc123456789!',
  'abcdefgh12345',

  // Keyboard patterns
  'asdfghjkl12345',
  'asdfghjkl1234!',
  'zxcvbnm1234567',
  '1234567890abcd',
  '1234567890abc!',
  '12345678901234',
  'qazwsx123456!',
  'qazwsxedc12345',

  // Leet speak variations
  'p@ssw0rd123456',
  'p@ssw0rd12345!',
  'p@$$w0rd123456',
  'passw0rd123456',
  'pa$$word123456',
  'p4ssw0rd123456',

  // Company/tech patterns
  'microsoft12345',
  'google12345678',
  'facebook123456',
  'linkedin123456',
  'instagram12345',
  'twitter1234567',

  // Date-based patterns
  'january1234567',
  'summer12345678',
  'winter12345678',
  'spring12345678',

  // Simple repeated/sequential
  'aaaaaa12345678',
  'abcabc12345678',
  '111111abcdefgh',
  '123456abcdefgh',

  // Common names with numbers
  'michael12345678',
  'jennifer1234567',
  'jessica12345678',
  'ashley12345678!',
  'charlie12345678',

  // Test/temporary passwords
  'testing12345678',
  'test1234567890',
  'testpassword123',
  'temppassword123',
  'temporary123456',
  'default12345678',
  'guest1234567890',
];
