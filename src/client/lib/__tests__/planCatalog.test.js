const { BILLING_PLANS } = require('../../../shared/constants/billing.js');
const {
  getStorageLimitForTier,
  TIERS,
} = require('../../../shared/constants/tiers.js');
const { PLAN_CATALOG } = require('../planCatalog.js');

const APPROVED_HELPER_TEXT = "You'll review pricing and payment details in Stripe Checkout before confirming.";

describe('planCatalog', () => {
  const premiumPlan = PLAN_CATALOG[BILLING_PLANS.PREMIUM_MONTHLY];

  afterEach(() => {
    jest.dontMock('../../../shared/constants/tiers.js');
    jest.resetModules();
  });

  it('stores only the approved frozen UI contract under the canonical plan id', () => {
    expect(Object.keys(PLAN_CATALOG)).toEqual([BILLING_PLANS.PREMIUM_MONTHLY]);
    expect(Object.keys(premiumPlan).sort()).toEqual([
      'benefits',
      'checkoutHelperText',
      'displayName',
      'planId',
      'title',
    ]);
    expect(premiumPlan).toMatchObject({
      planId: BILLING_PLANS.PREMIUM_MONTHLY,
      displayName: 'Premium',
      title: 'Premium Features',
      checkoutHelperText: APPROVED_HELPER_TEXT,
    });
    expect(Object.isFrozen(PLAN_CATALOG)).toBe(true);
    expect(Object.isFrozen(premiumPlan)).toBe(true);
    expect(Object.isFrozen(premiumPlan.benefits)).toBe(true);
  });

  it('derives the approved storage benefit from canonical tier limits', () => {
    const paidLimit = getStorageLimitForTier(TIERS.PAID).maxJobs;
    const freeLimit = getStorageLimitForTier(TIERS.FREE).maxJobs;

    expect(premiumPlan.benefits).toEqual([
      `Up to ${paidLimit.toLocaleString('en-US')} active applications, compared with ${freeLimit.toLocaleString('en-US')} on Free.`,
    ]);
  });

  it('does not advertise AI tailoring or a price in plan benefits', () => {
    const benefitCopy = premiumPlan.benefits.join(' ');

    expect(benefitCopy).not.toMatch(/\bAI\b|tailor/i);
    expect(benefitCopy).not.toMatch(/\$\s*\d|\b(?:USD|dollars?|price|pricing|per month|monthly)\b/i);
  });

  it.each([
    ['free', undefined],
    ['paid', { maxJobs: 0 }],
    ['free', { maxJobs: -1 }],
    ['paid', { maxJobs: 1.5 }],
    ['free', { maxJobs: Number.NaN }],
    ['paid', { maxJobs: Number.MAX_SAFE_INTEGER + 1 }],
  ])('fails loudly when the %s storage configuration is invalid', (invalidTier, invalidStorage) => {
    jest.resetModules();
    jest.doMock('../../../shared/constants/tiers.js', () => ({
      TIERS: {
        FREE: 'free',
        PAID: 'paid',
      },
      getStorageLimitForTier: (tier) => (
        tier === invalidTier ? invalidStorage : { maxJobs: 100 }
      ),
    }));

    expect(() => require('../planCatalog.js')).toThrow(
      `Missing valid storage maxJobs configuration for the "${invalidTier}" tier.`
    );
  });
});
