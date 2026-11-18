/** Run the Gate 1 build-tool contracts in Node, including the real-Git archive fixture. */
module.exports = {
  roots: ['<rootDir>/scripts/gate1-build-tools'],
  testEnvironment: 'node',
  testMatch: ['**/__tests__/*.test.cjs'],
  moduleFileExtensions: ['cjs', 'js', 'json'],
  transform: {},
};
