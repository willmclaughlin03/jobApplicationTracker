/** Run Gate 1 build/static-CI contracts in Node, including the real-Git archive fixture. */
module.exports = {
  roots: ['<rootDir>/scripts/gate1-build-tools', '<rootDir>/scripts/gate1-ci-tools'],
  testEnvironment: 'node',
  testMatch: ['**/__tests__/*.test.cjs'],
  moduleFileExtensions: ['cjs', 'js', 'json'],
  transform: {},
};
