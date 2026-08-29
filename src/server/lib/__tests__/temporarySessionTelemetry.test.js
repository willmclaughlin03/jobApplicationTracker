import {
  createTemporarySessionTelemetry,
  TEMPORARY_SESSION_FAILURE_REASONS,
  TEMPORARY_SESSION_TELEMETRY_EVENTS,
} from '../temporarySessionTelemetry.js';

describe('temporarySessionTelemetry', () => {
  it('records only fixed event/reason enums and bounded duration buckets', () => {
    const telemetry = createTemporarySessionTelemetry({
      now: () => 0,
      randomBytesFunction: () => Buffer.alloc(12, 1),
      env: {},
    });
    telemetry.record(
      TEMPORARY_SESSION_TELEMETRY_EVENTS.SECRET_REFRESH_FAILED,
      TEMPORARY_SESSION_FAILURE_REASONS.SECRET_UNAVAILABLE
    );
    telemetry.record('arbitrary_provider_error', 'arbitrary_reason');
    telemetry.finish(
      'unavailable',
      TEMPORARY_SESSION_FAILURE_REASONS.REDIS_UNCERTAIN,
      275
    );
    const snapshot = telemetry.getSnapshot();
    expect(snapshot.events.secretRefreshFailed).toBe(1);
    expect(snapshot.events.unavailable).toBe(1);
    expect(snapshot.reasons.secret_unavailable).toBe(1);
    expect(snapshot.reasons.redis_uncertain).toBe(1);
    expect(snapshot.durations.lt500).toBe(1);
    expect(snapshot.events).not.toHaveProperty('arbitrary_provider_error');
    expect(snapshot.reasons).not.toHaveProperty('arbitrary_reason');
  });

  it('emits one aggregate info summary without per-rejection warnings', () => {
    let clock = 0;
    const logger = { info: jest.fn(), warn: jest.fn() };
    const telemetry = createTemporarySessionTelemetry({
      now: () => clock,
      reportingWindowMs: 60_000,
      randomBytesFunction: () => Buffer.alloc(12, 2),
      env: { NEXT_BUILD_ID: 'synthetic-build-1' },
    });
    telemetry.finish(
      'rate_limited',
      TEMPORARY_SESSION_FAILURE_REASONS.LIMIT_EXCEEDED,
      20
    );
    telemetry.maybeRotate(logger);
    expect(logger.info).not.toHaveBeenCalled();
    clock = 60_000;
    telemetry.maybeRotate(logger);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info.mock.calls[0][0]).toMatchObject({
      event: 'temporary_session_ceiling_summary',
      total: 1,
      reasons: { limit_exceeded: 1 },
    });
  });

  it('bounds build attribution and keeps boot identity out of limiter inputs', () => {
    const telemetry = createTemporarySessionTelemetry({
      now: () => 0,
      randomBytesFunction: () => Buffer.alloc(12, 3),
      env: {
        NEXT_BUILD_ID: 'x'.repeat(129),
        AWS_AMPLIFY_DEPLOYMENT_ID: 'synthetic-deployment-1',
      },
    });
    expect(telemetry.getSnapshot().attribution).toEqual({
      moduleBootId: Buffer.alloc(12, 3).toString('base64url'),
      buildId: 'unknown',
      deploymentId: 'synthetic-deployment-1',
    });
  });
});
