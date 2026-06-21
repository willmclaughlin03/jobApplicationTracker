const {
  formatStorageDate,
  getStorageCount,
  hasLockedArchive,
  shouldShowPremiumCancelingStorageWarning,
  shouldShowTerminalFreeArchiveCopy,
} = require('../storageSummaryUi.js');
const { STORAGE_STATUSES } = require('../../../shared/constants/billing.js');

describe('storageSummaryUi', () => {
  it('normalizes invalid counts to zero', () => {
    expect(getStorageCount(-1)).toBe(0);
    expect(getStorageCount(null)).toBe(0);
    expect(getStorageCount(3)).toBe(3);
  });

  it('formats valid storage dates without rendering invalid date text', () => {
    expect(formatStorageDate('2026-07-15T12:00:00.000Z')).toBe('July 15, 2026');
    expect(formatStorageDate('not-a-date')).toBeNull();
    expect(formatStorageDate(null)).toBeNull();
  });

  it('shows canceling Premium warnings only for positive projected overflow', () => {
    expect(shouldShowPremiumCancelingStorageWarning({
      status: STORAGE_STATUSES.PREMIUM_CANCELING,
      cancelAtPeriodEnd: true,
      projectedOverflowCount: 12,
    })).toBe(true);

    expect(shouldShowPremiumCancelingStorageWarning({
      status: STORAGE_STATUSES.PREMIUM_CANCELING,
      cancelAtPeriodEnd: true,
      projectedOverflowCount: 0,
    })).toBe(false);
  });

  it('does not show confirmed downgrade copy for ambiguous billing states', () => {
    expect(shouldShowPremiumCancelingStorageWarning({
      status: STORAGE_STATUSES.BILLING_UNAVAILABLE,
      cancelAtPeriodEnd: true,
      projectedOverflowCount: 12,
    })).toBe(false);

    expect(shouldShowTerminalFreeArchiveCopy({
      status: STORAGE_STATUSES.BILLING_RECONCILIATION_PENDING,
      lockedCount: 8,
      projectedOverflowCount: 12,
    })).toBe(false);
  });

  it('shows terminal-Free archive copy only when archive or overflow counts exist', () => {
    expect(shouldShowTerminalFreeArchiveCopy({
      status: STORAGE_STATUSES.TERMINAL_FREE,
      lockedCount: 1,
      projectedOverflowCount: 0,
    })).toBe(true);

    expect(shouldShowTerminalFreeArchiveCopy({
      status: STORAGE_STATUSES.TERMINAL_FREE,
      lockedCount: 0,
      projectedOverflowCount: 0,
    })).toBe(false);
  });

  it('detects locked archive availability from count metadata', () => {
    expect(hasLockedArchive({ lockedCount: 1 })).toBe(true);
    expect(hasLockedArchive({ lockedCount: 0 })).toBe(false);
  });
});
