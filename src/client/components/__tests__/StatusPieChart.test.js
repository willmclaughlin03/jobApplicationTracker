/**
 * Tests for StatusPieChart component
 *
 * Purpose: Verify the pie chart's segment math, normalization, accessibility,
 * and rendering behavior across edge cases.
 *
 * Connects to: src/client/components/StatusPieChart.jsx
 *
 * Test coverage:
 * - buildSegments: empty state, single status, multiple statuses
 * - Normalization: segments sum to 100% after min-arc clamping
 * - Minimum arc: tiny counts still produce visible segments
 * - React rendering: SVG attributes, aria-label, loading skeleton, empty state
 *
 * @jest-environment jsdom
 */

const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react');
const { buildSegments } = require('../StatusPieChart');

// Enable React 18 act() environment for createRoot
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** Helper: render a React element into a fresh container and return it */
function renderInto(element) {
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return container;
}

// =========================================================================
// buildSegments — pure logic tests
// =========================================================================

describe('buildSegments', () => {
  it('returns empty array when all counts are zero', () => {
    const counts = { applied: 0, interviewing: 0, offered: 0, rejected: 0, accepted: 0 };
    expect(buildSegments(counts, 0)).toEqual([]);
  });

  it('returns a single segment at 100% for one non-zero status', () => {
    const counts = { applied: 10, interviewing: 0, offered: 0, rejected: 0, accepted: 0 };
    const segments = buildSegments(counts, 10);

    expect(segments).toHaveLength(1);
    expect(segments[0].value).toBe('applied');
    expect(segments[0].count).toBe(10);
    expect(segments[0].percentage).toBeCloseTo(100, 4);
  });

  it('returns correct proportions for multiple statuses', () => {
    const counts = { applied: 50, interviewing: 30, offered: 20, rejected: 0, accepted: 0 };
    const segments = buildSegments(counts, 100);

    expect(segments).toHaveLength(3);
    expect(segments[0].percentage).toBeCloseTo(50, 1);
    expect(segments[1].percentage).toBeCloseTo(30, 1);
    expect(segments[2].percentage).toBeCloseTo(20, 1);
  });

  it('only includes statuses with count > 0', () => {
    const counts = { applied: 5, interviewing: 0, offered: 3, rejected: 0, accepted: 0 };
    const segments = buildSegments(counts, 8);

    const values = segments.map((s) => s.value);
    expect(values).toEqual(['applied', 'offered']);
  });

  // =========================================================================
  // Minimum arc enforcement
  // =========================================================================

  it('enforces minimum percentage for tiny counts', () => {
    const counts = { applied: 1, interviewing: 0, offered: 0, rejected: 499, accepted: 0 };
    const segments = buildSegments(counts, 500);

    const appliedSegment = segments.find((s) => s.value === 'applied');
    // Raw would be 0.2%, but minimum arc should push it above 1%
    expect(appliedSegment.percentage).toBeGreaterThan(1);
  });

  // =========================================================================
  // Normalization — segments always sum to 100%
  // =========================================================================

  it('normalizes segments to sum to exactly 100% after clamping', () => {
    const counts = { applied: 50, interviewing: 30, offered: 20, rejected: 0, accepted: 0 };
    const segments = buildSegments(counts, 100);
    const sum = segments.reduce((acc, s) => acc + s.percentage, 0);

    expect(sum).toBeCloseTo(100, 4);
  });

  it('normalizes to 100% when multiple small counts are clamped to minimum', () => {
    // 5 statuses each with 1 job — all get the same raw %, all clamped, then normalized
    const counts = { applied: 1, interviewing: 1, offered: 1, rejected: 1, accepted: 1 };
    const segments = buildSegments(counts, 5);
    const sum = segments.reduce((acc, s) => acc + s.percentage, 0);

    expect(segments).toHaveLength(5);
    expect(sum).toBeCloseTo(100, 4);
  });

  it('normalizes to 100% with a mix of large and tiny counts', () => {
    const counts = { applied: 1, interviewing: 2, offered: 3, rejected: 494, accepted: 0 };
    const segments = buildSegments(counts, 500);
    const sum = segments.reduce((acc, s) => acc + s.percentage, 0);

    expect(segments).toHaveLength(4);
    expect(sum).toBeCloseTo(100, 4);
  });
});

// =========================================================================
// React rendering tests
// =========================================================================

describe('StatusPieChart rendering', () => {
  let StatusPieChart;

  beforeAll(() => {
    StatusPieChart = require('../StatusPieChart').default;
  });

  it('renders nothing when total is 0 and not loading', () => {
    const counts = { applied: 0, interviewing: 0, offered: 0, rejected: 0, accepted: 0 };
    const container = renderInto(
      React.createElement(StatusPieChart, { statusCounts: counts, total: 0, loading: false })
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders a skeleton with animate-pulse when loading', () => {
    const counts = { applied: 0, interviewing: 0, offered: 0, rejected: 0, accepted: 0 };
    const container = renderInto(
      React.createElement(StatusPieChart, { statusCounts: counts, total: 0, loading: true })
    );
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg.classList.contains('animate-pulse')).toBe(true);
    expect(svg.getAttribute('aria-label')).toBe('Loading status chart');
  });

  it('renders SVG with role="img" and descriptive aria-label', () => {
    const counts = { applied: 5, interviewing: 3, offered: 0, rejected: 2, accepted: 0 };
    const container = renderInto(
      React.createElement(StatusPieChart, { statusCounts: counts, total: 10, loading: false })
    );
    const svg = container.querySelector('svg');
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toContain('5 applied');
    expect(svg.getAttribute('aria-label')).toContain('3 interviewing');
    expect(svg.getAttribute('aria-label')).toContain('2 rejected');
  });

  it('renders a viewBox attribute for responsive scaling', () => {
    const counts = { applied: 10, interviewing: 0, offered: 0, rejected: 0, accepted: 0 };
    const container = renderInto(
      React.createElement(StatusPieChart, { statusCounts: counts, total: 10, loading: false })
    );
    const svg = container.querySelector('svg');
    expect(svg.getAttribute('viewBox')).toBe('0 0 100 100');
  });

  it('renders correct number of circle segments for non-zero statuses', () => {
    const counts = { applied: 5, interviewing: 3, offered: 0, rejected: 2, accepted: 0 };
    const container = renderInto(
      React.createElement(StatusPieChart, { statusCounts: counts, total: 10, loading: false })
    );
    const circles = container.querySelectorAll('circle[stroke-dasharray]');
    expect(circles).toHaveLength(3);
  });

  it('renders title tooltips on each segment', () => {
    const counts = { applied: 5, interviewing: 0, offered: 0, rejected: 0, accepted: 0 };
    const container = renderInto(
      React.createElement(StatusPieChart, { statusCounts: counts, total: 5, loading: false })
    );
    const titles = container.querySelectorAll('title');
    expect(titles).toHaveLength(1);
    expect(titles[0].textContent).toBe('Applied: 5 (100%)');
  });

  it('displays total count as centered text', () => {
    const counts = { applied: 7, interviewing: 3, offered: 0, rejected: 0, accepted: 0 };
    const container = renderInto(
      React.createElement(StatusPieChart, { statusCounts: counts, total: 10, loading: false })
    );
    const text = container.querySelector('text');
    expect(text.textContent).toBe('10');
  });

  it('stroke-dasharray values sum to full circumference per segment', () => {
    const counts = { applied: 5, interviewing: 3, offered: 2, rejected: 0, accepted: 0 };
    const container = renderInto(
      React.createElement(StatusPieChart, { statusCounts: counts, total: 10, loading: false })
    );
    const circles = container.querySelectorAll('circle[stroke-dasharray]');
    const RADIUS = 35;
    const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

    circles.forEach((circle) => {
      const [dash, gap] = circle.getAttribute('stroke-dasharray').split(' ').map(Number);
      expect(dash + gap).toBeCloseTo(CIRCUMFERENCE, 2);
    });
  });
});
