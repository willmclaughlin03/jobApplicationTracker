'use strict';
/* global __dirname */

/** Run only offline synthetic contracts; all HTTP, Next, systemd and child launch paths are mocked. */
module.exports = { rootDir: __dirname, testEnvironment: 'node', transform: {}, testMatch: ['**/__tests__/*.test.cjs'],
  moduleFileExtensions: ['cjs', 'js', 'json'], cache: false, maxWorkers: 1 };
