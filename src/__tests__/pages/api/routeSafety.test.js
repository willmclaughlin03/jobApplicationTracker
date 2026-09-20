/**
 * Safety net test: Ensures all API route files use approved wrapper entrypoints
 *
 * Purpose: Prevent new routes from being added without one of the approved
 * centralized wrappers. If this test fails, a developer has added a route
 * that bypasses the supported middleware entrypoints.
 *
 * Connects to: All files in src/pages/api/ (excluding __tests__/)
 *
 * How it works:
 * - Recursively scans src/pages/api/ for .js route files
 * - Reads each file's source code
 * - Verifies a direct approved wrapper export or the session probe composition
 * - Fails CI with a clear message listing unwrapped routes
 */

const fs = require('fs');
const path = require('path');
const { parse } = require('@babel/parser');

// Routes that intentionally skip withRateLimit — currently none.
// health.js was moved behind withRateLimit with OPERATIONS.HEALTH (60 req/hour per IP).
const EXCLUDED_ROUTES = [];

/**
 * Recursively collects all .js route files from a directory
 * Excludes __tests__ directories
 *
 * Assumption: All API routes in this project are .js files.
 * If .ts/.tsx routes are added in the future, extend the
 * endsWith check below to include those extensions.
 *
 * @param {string} dir - Directory to scan
 * @returns {string[]} Array of absolute file paths
 */
function getRouteFiles(dir) {
  const files = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    if (EXCLUDED_ROUTES.includes(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...getRouteFiles(fullPath));
    } else if (entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Restricts webhook-only wrappers to webhook filenames or directories.
 * @param {string} relativePath - Route path using either platform's separators.
 * @returns {boolean} Whether the route may use withWebhookAuth.
 */
function isWebhookRoute(relativePath) {
  return /(^|[\\/])webhooks?(?:controller|route)?\.(js|ts)$|(^|[\\/])webhooks?(?:[\\/]|$)/i.test(relativePath);
}

/**
 * Matches an actual identifier so strings and member accesses cannot impersonate it.
 * @param {object} node - Parsed syntax node.
 * @param {string} name - Required identifier name.
 * @returns {boolean} Whether the node names the expected binding.
 */
function isIdentifier(node, name) {
  return node?.type === 'Identifier' && node.name === name;
}

/**
 * Requires a call to forward the original request and response without substitutions.
 * @param {object} node - Parsed call expression.
 * @returns {boolean} Whether its only arguments are req and res, in order.
 */
function forwardsRequestAndResponse(node) {
  return node?.type === 'CallExpression'
    && node.arguments.length === 2
    && isIdentifier(node.arguments[0], 'req')
    && isIdentifier(node.arguments[1], 'res');
}

/**
 * Recognizes only the session route's observational probe followed by its limiter.
 * Requires trusted imports, an immutable top-level limiter binding, and exactly two
 * wrapper statements so an early return, shadowed binding, or branch cannot bypass it.
 * @param {object[]} statements - Parsed module statements; comments are excluded.
 * @param {object} exported - Actual default-export declaration.
 * @param {string} relativePath - Route path, scoped to pages/api/auth/session.js.
 * @returns {boolean} Whether the approved composition is structurally intact.
 */
function isSessionProbeComposition(statements, exported, relativePath) {
  if (relativePath.replace(/\\/g, '/') !== 'pages/api/auth/session.js'
    || exported?.type !== 'FunctionDeclaration'
    || !isIdentifier(exported.id, 'sessionWithRestartProbe')
    || exported.generator
    || exported.params.length !== 2
    || !isIdentifier(exported.params[0], 'req')
    || !isIdentifier(exported.params[1], 'res')
    || exported.body.body.length !== 2) return false;

  const hasTrustedImports = [
    ['withRateLimit', '../../../server/middleware/withRateLimit.js'],
    ['gate1RestartProbe', '../../../server/lib/gate1RestartProbe.js'],
  ].every(([name, source]) => statements.some((statement) =>
    statement.type === 'ImportDeclaration' && statement.source.value === source
    && statement.specifiers.some((specifier) => specifier.type === 'ImportSpecifier'
      && isIdentifier(specifier.imported, name) && isIdentifier(specifier.local, name))
  ));
  const hasWrappedRoute = statements.some((statement) =>
    statement.type === 'VariableDeclaration' && statement.kind === 'const'
    && statement.declarations.some((declaration) =>
      isIdentifier(declaration.id, 'sessionRoute')
      && declaration.init?.type === 'CallExpression'
      && isIdentifier(declaration.init.callee, 'withRateLimit')
      && declaration.init.arguments.length === 2
      && isIdentifier(declaration.init.arguments[0], 'handler')
      && declaration.init.arguments[1].type === 'ObjectExpression'
    )
  );
  const [observation, delegation] = exported.body.body;
  const probeCall = observation.expression;
  return hasTrustedImports && hasWrappedRoute
    && observation.type === 'ExpressionStatement'
    && forwardsRequestAndResponse(probeCall)
    && probeCall.callee.type === 'MemberExpression'
    && !probeCall.callee.computed
    && isIdentifier(probeCall.callee.object, 'gate1RestartProbe')
    && isIdentifier(probeCall.callee.property, 'attach')
    && delegation.type === 'ReturnStatement'
    && forwardsRequestAndResponse(delegation.argument)
    && isIdentifier(delegation.argument.callee, 'sessionRoute');
}

/**
 * Checks the actual export instead of matching wrapper text in comments or strings.
 * Uses the Babel parser already installed with the Jest/Next toolchain; no route runs.
 * @param {string} content - Complete route source.
 * @param {string} relativePath - Route path for webhook and session restrictions.
 * @returns {boolean} Whether a supported wrapper is present; invalid syntax fails closed.
 */
function hasApprovedWrapper(content, relativePath) {
  let statements;
  try {
    statements = parse(content, { sourceType: 'module' }).program.body;
  } catch {
    return false;
  }
  const exported = statements.find((statement) =>
    statement.type === 'ExportDefaultDeclaration'
  )?.declaration;
  if (exported?.type === 'CallExpression') {
    return isIdentifier(exported.callee, 'withRateLimit')
      || (isWebhookRoute(relativePath) && isIdentifier(exported.callee, 'withWebhookAuth'));
  }
  return isSessionProbeComposition(statements, exported, relativePath);
}

describe('API Route Safety', () => {
  const APPROVED_WRAPPER_EXPORTS = [
    'export default withRateLimit(',
  ];
  const WEBHOOK_WRAPPER_EXPORT = 'export default withWebhookAuth(';

  const sessionProbeSource = `
    import { withRateLimit } from '../../../server/middleware/withRateLimit.js';
    import { gate1RestartProbe } from '../../../server/lib/gate1RestartProbe.js';
    const sessionRoute = withRateLimit(handler, {});
    export default function sessionWithRestartProbe(req, res) {
      gate1RestartProbe.attach(req, res);
      return sessionRoute(req, res);
    }
  `;

  /**
   * Keeps the direct export and webhook path rules while ignoring formatting.
   */
  it.each([
    ['pages/api/jobs.js', 'export default withRateLimit(handler, {});', true],
    ['pages/api/jobs.js', 'export default withRateLimit (handler, {});', true],
    ['pages/api/billing/webhook.js', 'export default withWebhookAuth(handler, {});', true],
    ['pages/api/webhooks/events.js', 'export default withWebhookAuth(handler, {});', true],
    ['pages\\api\\billing\\webhook.js', 'export default withWebhookAuth(handler, {});', true],
    ['pages/api/jobs.js', 'export default withWebhookAuth(handler, {});', false],
    ['pages/api/jobs.js', 'export default handler;', false],
    ['pages/api/jobs.js', '// export default withRateLimit(handler, {});\nexport default handler;', false],
    ['pages/api/jobs.js', 'const text = "export default withRateLimit("; export default handler;', false],
    ['pages/api/jobs.js', 'export default withRateLimit(', false],
  ])('checks the actual direct export for %s (case %#)', (relativePath, source, approved) => {
    expect(hasApprovedWrapper(source, relativePath)).toBe(approved);
  });

  /**
   * Both CI and Windows paths accept the same constrained session composition.
   */
  it.each(['pages/api/auth/session.js', 'pages\\api\\auth\\session.js'])(
    'accepts the observational session composition at %s', (relativePath) => {
      expect(hasApprovedWrapper(sessionProbeSource, relativePath)).toBe(true);
    }
  );

  /**
   * The session exception cannot authorize unrelated routes.
   */
  it('rejects the session composition on another route', () => {
    expect(hasApprovedWrapper(sessionProbeSource, 'pages/api/jobs.js')).toBe(false);
  });

  /**
   * Mutations model concrete ways a composed export could stop enforcing middleware.
   */
  it.each([
    ['missing middleware', 'withRateLimit(handler, {})', 'handler'],
    ['unused middleware', 'return sessionRoute(req, res);', 'return handler(req, res);'],
    ['comment-only middleware', 'const sessionRoute =', '// const sessionRoute ='],
    ['mutable middleware binding', 'const sessionRoute =', 'let sessionRoute ='],
    ['untrusted middleware import', '../../../server/middleware/withRateLimit.js', './fake.js'],
    ['untrusted probe import', '../../../server/lib/gate1RestartProbe.js', './fake.js'],
    ['early return', 'gate1RestartProbe.attach(req, res);',
      'if (req.query.bypass) return handler(req, res); gate1RestartProbe.attach(req, res);'],
    ['conditional delegation', 'return sessionRoute(req, res);',
      'return req.query.bypass ? handler(req, res) : sessionRoute(req, res);'],
    ['shadowed middleware binding', 'return sessionRoute(req, res);',
      'const sessionRoute = handler; return sessionRoute(req, res);'],
    ['shadowing function name', 'function sessionWithRestartProbe', 'function sessionRoute'],
    ['substituted request', 'return sessionRoute(req, res);', 'return sessionRoute({}, res);'],
    ['generator export', 'function sessionWithRestartProbe', 'function* sessionWithRestartProbe'],
  ])('rejects a session composition with %s', (_description, original, replacement) => {
    expect(sessionProbeSource).toContain(original);
    expect(hasApprovedWrapper(
      sessionProbeSource.replace(original, replacement), 'pages/api/auth/session.js'
    )).toBe(false);
  });

  /**
   * Test: All route files must use one of the approved wrappers
   *
   * Scans every .js file in src/pages/api/ (excluding __tests__/) and
   * verifies its actual export uses an approved wrapper. The session probe may
   * observe requests before unconditionally returning its rate-limited route.
   * This catches any new route that was added without the middleware wrapper.
   *
   * If this test fails, wrap your new route handler with:
   *   export default withRateLimit(handler, { requireAuth: true })
   *
   * For public routes (no auth required), use:
   *   export default withRateLimit(handler, { requireAuth: false, operation: OPERATIONS.AUTH })
   *
   * Webhook-named routes may use:
   *   export default withWebhookAuth(handler, { allowedMethods: ['POST'] })
   */
  it('all API routes should be wrapped with an approved middleware wrapper', () => {
    const apiDir = path.resolve(__dirname, '../../../pages/api');
    const routeFiles = getRouteFiles(apiDir);

    // Sanity check: we should find at least the known route files
    expect(routeFiles.length).toBeGreaterThan(0);

    const unwrappedRoutes = [];

    for (const filePath of routeFiles) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const relativePath = path.relative(path.resolve(__dirname, '../../..'), filePath);
      if (!hasApprovedWrapper(content, relativePath)) {
        unwrappedRoutes.push(relativePath);
      }
    }

    if (unwrappedRoutes.length > 0) {
      throw new Error(
        `The following API routes are NOT wrapped with an approved middleware wrapper:\n` +
        unwrappedRoutes.map((r) => `  - ${r}`).join('\n') +
        `\n\nNon-webhook routes must use:\n` +
        APPROVED_WRAPPER_EXPORTS.map((wrapperExport) => `  - ${wrapperExport}...`).join('\n') +
        `\nWebhook-named routes may also use:\n` +
        `  - ${WEBHOOK_WRAPPER_EXPORT}...` +
        `\nThe session route may also observe with gate1RestartProbe.attach(req, res), then\n` +
        `unconditionally return its const sessionRoute = withRateLimit(...) handler.\n` +
        `\nSee src/server/middleware/withRateLimit.js and src/server/middleware/withWebhookAuth.js for usage.`
      );
    }
  });
});
