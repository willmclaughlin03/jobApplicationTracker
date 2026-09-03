/**
 * Runtime compatibility tests for the real job-schema sanitizer.
 *
 * Purpose: Keep the production isomorphic-dompurify dependency loadable from
 * strict CommonJS runtimes such as the Vercel server bundle while verifying
 * that job-field sanitization still uses the real library rather than a mock.
 *
 * Connects to: shared/validations/jobSchema.js and isomorphic-dompurify.
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const { jobSchema } = require('../jobSchema.js');

const PROJECT_ROOT = path.resolve(__dirname, '../../../..');
const STRICT_COMMONJS_SANITIZER_SCRIPT = [
  "const DOMPurify = require('isomorphic-dompurify');",
  "const clean = DOMPurify.sanitize('<img src=x onerror=alert(1)>Safe', { ALLOWED_TAGS: [] });",
  "if (clean !== 'Safe') throw new Error('Unexpected sanitizer output');",
  "process.stdout.write('strict-commonjs-sanitizer-ok');",
].join('\n');

/**
 * Exercise both schema behavior and the dependency-loading boundary that
 * previously failed before Next.js API middleware could run.
 */
describe('jobSchema production sanitizer runtime', () => {
  /**
   * Confirm the schema imports the real sanitizer and strips executable HTML
   * without relying on the lightweight mock used by the broad schema suite.
   */
  it('sanitizes job fields with the real isomorphic-dompurify package', () => {
    const result = jobSchema.safeParse({
      company: '<img src=x onerror=alert(1)>Acme',
      position: '<script>alert(1)</script>Engineer',
      notes: '<svg onload=alert(1)></svg>Ready',
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      company: 'Acme',
      position: 'Engineer',
      notes: 'Ready',
    });
  });

  /**
   * Disable Node's require(ESM) bridge in a child process to reproduce the
   * strict CommonJS boundary used by the failing deployed server bundle.
   */
  it('loads and runs the sanitizer through strict CommonJS', () => {
    const result = spawnSync(
      process.execPath,
      ['--no-experimental-require-module', '-e', STRICT_COMMONJS_SANITIZER_SCRIPT],
      {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        windowsHide: true,
      }
    );

    expect({
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
    }).toEqual({
      status: 0,
      signal: null,
      stdout: 'strict-commonjs-sanitizer-ok',
      stderr: '',
    });
  });
});
