'use strict';
/* global __dirname */

/** Isolate synthetic fixtures; no application suites, dependency installation or live execution. */
module.exports = { rootDir: __dirname, testEnvironment: 'node', transform: {}, testMatch: ['**/__tests__/*.test.cjs'],
  moduleFileExtensions: ['cjs', 'js', 'json'], cache: false, maxWorkers: 1 };
