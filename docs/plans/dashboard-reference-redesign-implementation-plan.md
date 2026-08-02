# Plan: TrackTheApp Dashboard Reference Redesign

Branch: agent/tmp-premium-restore-rpc-reconciliation · Created: 2026-07-28 · Plan version: 3

## Loop status

- Stage: 1 (implementation)
- Rounds used: plan-audit 0/3 · convergence 0/3 · pr-fix 0/2
- GATE 1 (implementation plan approved): complete - approved by Will on 2026-07-29
- GATE 2 (pre-PR approved): pending
- GATE 3 (merged): pending
- Open escalations: none

## Goal

Redesign the authenticated TrackTheApp homepage to closely match the supplied emerald-noir Job
Application Tracker reference while preserving the application's current features, data
contracts, billing behavior, and accessibility guarantees. The result should use the
TrackTheApp brand, a responsive application shell, a collapsible Filters panel, dense
application rows, near-black forest-green foundations, layered dark-emerald surfaces, and
vivid spring-green active highlights without adding mock-only product features or generated
decorative artwork.

## Reference

- Current color/theme source: the emerald-black reference image supplied by Will in the
  2026-07-28 planning conversation.
- The existing `C:\Users\willm\OneDrive\Desktop\mainPageDesign.png` file is the previous
  blue/slate colorway. It remains useful for the unchanged layout composition but is superseded
  for palette, surface, separator, active-state, and background treatment.
- Before implementation, save the new reference at an implementation-accessible stable path
  and record that path here. If it is temporarily unavailable, the locked token and CSS
  background contracts below are authoritative.
- The browser frame in the reference is presentation context and is not part of the app.
- TrackerPro marks, company logos, and the generated user avatar are reference-only assets
  and must not be copied.
- The forest silhouette, particles, noise, and other representational/generated background
  artwork are reference-only. Reproduce the color atmosphere and upper-center/right directional
  light field only with the static, abstract CSS gradients defined below; do not copy scenery
  or load a decorative asset.
- Implementation begins with a local signed-in baseline screenshot when browser access is
  available.

## Acceptance criteria

1. The dashboard uses `TrackTheApp` everywhere in the redesigned shell and contains no
   `TrackerPro` text, logo, domain, or generated identity.
2. The product mark defaults to a text-only `TrackTheApp` wordmark unless Will supplies or
   approves a separate brand asset.
3. The fake browser chrome shown in the reference is not rendered by the application.
4. At wide desktop widths, the dashboard presents an expanded product rail, a Filters
   panel, and an applications workspace as three visually related columns.
5. The Filters panel is collapsible. Closing it expands the applications workspace into the
   released column, and the Filters control reopens it.
6. Collapsing Filters preserves active status, salary, company-search, and selected-date
   state. Only the existing Clear All Filters action resets filters.
7. On narrower layouts, Filters uses the existing drawer interaction and closes through its
   close control, Escape, or backdrop. Focus returns to the Filters trigger.
8. Filter disclosure controls expose correct `aria-expanded` and `aria-controls` state.
9. Dashboard navigation includes only the current Applications section, Filters, Activity,
   and the existing billing entry action (`Upgrade`, `Manage plan`, or its canonical
   fallback). It does not invent navigation destinations.
10. The existing billing entry remains fail-closed: the non-interactive loading skeleton
    displays until the initial storage summary resolves, and a later job refresh does not
    replace a resolved billing entry.
11. The main toolbar contains the existing company search and Add Job behavior, visually
    presented as Search companies and Add Application.
12. The search label and placeholder do not imply position, notes, or full-text searching
    unless that behavior is separately implemented and approved.
13. The application table uses only existing job fields:
    - position as primary application text;
    - company as secondary application text;
    - `created_at` as Added;
    - the current status and optional `status_date`;
    - salary range;
    - notes;
    - Edit and Delete actions.
14. The dashboard renders only the five real statuses: Applied, Interviewing, Offered,
    Accepted, and Rejected.
15. Company images, company logos, favorite stars, and generated row artwork are absent.
16. Desktop Edit and Delete may be grouped behind one accessible overflow menu to match the
    reference's density. Mobile retains large, directly visible Edit and Delete controls.
17. The account control shows the user's email and chevron without a user image. Existing
    Sign Out and conditional Admin behavior remains available.
18. The following mock-only controls or features are absent:
    - Overview;
    - Insights;
    - Settings;
    - global sidebar Collapse;
    - Columns;
    - Export;
    - saved searches;
    - unread-note and follow-up quick filters;
    - favorites;
    - sorting;
    - job-type and source filters;
    - page-size selection;
    - a split Add Application menu.
19. The dashboard uses the approved emerald-noir hierarchy: a near-black forest-green canvas,
    progressively lighter dark-emerald surfaces, and vivid spring-green accents on primary,
    selected, focus, and major-boundary states. Glow remains localized and restrained.
20. The atmospheric background is produced with static dashboard-scoped CSS gradients,
    including one root-owned upper-center/right directional light field, plus a vignette. It
    does not use a loaded screenshot or generated art asset. Internal table rows and list
    separators use low-chroma green-gray without glow so they remain subordinate to major
    boundaries.
21. Normal text meets WCAG 2.2 AA contrast of at least 4.5:1, large text meets at least
    3:1, and meaningful UI boundaries/focus indicators meet non-text contrast requirements.
22. Interactive targets are at least 36px in the implementation target, exceeding WCAG
    2.2's 24px minimum target size.
23. The page reflows without loss of information at 320 CSS pixels. Below the desktop-table
    breakpoint, the existing card alternative prevents the entire page from requiring
    two-dimensional scrolling.
24. Existing add, update, delete, filtering, pagination, Activity, storage warning, locked
    archive, upgrade, authentication, and error behavior remains intact.
25. No API, database, migration, entitlement, ownership, Stripe, rate-limit, or server-side
    validation behavior changes in this redesign.
26. Loading, empty, error, storage, archive, form, drawer, dropdown, and modal states use the
    same dashboard visual language and do not reveal the previous light dashboard styling.
27. Unit tests, build verification, keyboard checks, contrast checks, and the responsive
    visual matrix pass before Gate 2.

## Non-goals

- Redesigning Login, Billing, Admin, error pages, or other routes.
- Adding light/dark theme selection or a Settings control.
- Upgrading Next.js, React, Tailwind CSS, Jest, or other unrelated dependencies.
- Migrating from the Pages Router.
- Introducing TanStack Table, server-side sorting, column configuration, or user-controlled
  page size.
- Adding new job fields such as applied date, source, job type, favorites, unread state, or
  company imagery.
- Changing filtering from the current in-memory implementation.
- Changing the fixed page size of ten.
- Changing billing or storage policy behavior.
- Adding browser chrome or copying reference-only branding and assets.
- Loading the supplied screenshot as the dashboard background or adding bitmap/SVG/canvas/WebGL
  forest, particle, noise, or other representational/generated decorative artwork.
- Adding animated light streaks or duplicating the permitted root-owned CSS directional light
  field inside panels, navigation, drawers, dialogs, or other components.
- Establishing Playwright infrastructure in the first UI patch; visual regression automation
  remains a separately approvable follow-up.

## Locked design decisions

### Branding and copy

- Brand: `TrackTheApp`, with no spaces in the shell wordmark.
- Wordmark: text-only by default.
- Page title: `Applications`.
- Supporting copy: `Track and manage your job applications.`
- Search placeholder: `Search companies...`
- Primary action label: `Add Application`.
- No TrackerPro tagline or reference-domain text.

### Wide layout

- Wide target breakpoint: approximately 1400px.
- Product rail: approximately 216-224px expanded.
- Filters panel: approximately 272-288px expanded.
- Workspace: `minmax(0, 1fr)` so it consumes the remaining width.
- The reference's approximately 1492px desktop composition is the primary visual comparison
  viewport.
- Major surfaces use 8-12px radii, layered dark-emerald fills, thin spring-green accent
  borders, and restrained localized glow.
- The workspace heading remains outside the table frame.

### Responsive layout

- `>=1400px`: expanded product rail, docked collapsible Filters panel, dense desktop table.
- `1024-1399px`: compact product rail, Filters and Activity as overlay drawers, desktop
  table where content remains readable.
- `<1024px`: mobile/tablet application cards replace the six-column table.
- `<768px`: compact top shell, wrapping toolbar, full-width cards, and overlay drawers.
- Breakpoints may move slightly during visual QA when required to prevent clipped text,
  but changes must preserve this behavior hierarchy.

### Collapsible Filters contract

- Filters is expanded by default at the wide reference viewport.
- The Filters header close control collapses the docked panel.
- The Filters navigation control toggles or reopens the panel.
- The application workspace expands when Filters collapses.
- Collapse/reopen animation target: approximately 200ms.
- Animations must be disabled or reduced under `prefers-reduced-motion`.
- Collapse state is session-local React state; no new local-storage or account preference is
  introduced.
- Filter criteria remain owned by the Dashboard/useJobs flow and survive visual collapse.
- On mobile/tablet, the existing accessible drawer pattern remains the interaction model.
- The responsive implementation must avoid duplicate form IDs and duplicate focusable
  filter controls in the DOM. Prefer one responsive panel or a shared content component with
  explicit unique ID prefixes.
- Focus returns to the correct Filters trigger after collapse or drawer close.

### Emerald background, surface, border, and glow treatment

Use the following values as the implementation starting point:

```css
--dash-canvas: 2 15 13;              /* #020F0D */
--dash-rail: 3 20 17;                /* #031411 */
--dash-surface: 6 31 24;             /* #061F18 */
--dash-surface-raised: 10 42 32;     /* #0A2A20 */
--dash-surface-hover: 12 51 38;      /* #0C3326 */
--dash-text: 243 247 244;            /* #F3F7F4 */
--dash-muted: 167 184 176;           /* #A7B8B0 */
--dash-line: 32 72 58;               /* #20483A */
--dash-accent: 93 218 112;           /* #5DDA70 */
--dash-accent-hover: 120 234 134;    /* #78EA86 */
--dash-accent-ink: 4 17 7;           /* #041107 */

--dash-active-fill: rgb(var(--dash-accent) / 0.16);
--dash-panel-border: rgb(var(--dash-accent) / 0.48);
--dash-control-border: rgb(var(--dash-accent) / 0.30);
--dash-focus-ring: rgb(var(--dash-accent-hover) / 0.90);
--dash-panel-glow:
  0 0 0 1px rgb(var(--dash-accent) / 0.08),
  0 0 28px rgb(var(--dash-accent) / 0.10);
```

Build the dashboard background from CSS color layers rather than an image:

```css
background:
  radial-gradient(circle at 62% 4%, rgb(var(--dash-accent) / 0.10), transparent 38%),
  radial-gradient(circle at 86% 100%, rgb(13 148 101 / 0.09), transparent 44%),
  radial-gradient(circle at 5% 76%, rgb(34 197 94 / 0.05), transparent 32%),
  linear-gradient(135deg, #020F0D 0%, #031713 52%, #020D0C 100%);
```

Add one dashboard-root directional light field above the canvas gradients and behind all
content. Implement it with static CSS gradients on a non-interactive pseudo-element:

- use one broad diagonal band at approximately 115-130 degrees and roughly `0.025-0.045`
  accent opacity;
- use two or three narrower linear or elliptical-radial gradient filaments at roughly
  `0.04-0.075` accent opacity to create the visible streak lines;
- confine the field to approximately the upper-center/right 25-35% of the dashboard and fade
  both ends so no hard line enters the main table body;
- at compact widths, reduce the filament count or opacity; at narrow mobile widths, retain the
  emerald wash and at most one subtle filament when it does not compete with content; and
- keep the layer static, free of blur-heavy filters, and owned only by `DashboardShell`.

These abstract CSS bands are the only permitted light-streak treatment. They are part of the
color atmosphere, not generated artwork, and must not be recreated inside individual panels
or overlays.

Add a separate dashboard-scoped, non-interactive pseudo-element, or an equivalent ordered
gradient layer, with
`radial-gradient(ellipse at center, transparent 35%, rgb(0 5 4 / 0.42) 100%)` for the edge
vignette. The directional field and vignette must be static, clipped to the authenticated
dashboard, use `pointer-events: none`, avoid stacking traps, and sit behind all content. Do not
load the supplied reference as a background, add bitmap/SVG/canvas/WebGL scenery, synthesize
forest/particle/noise artwork, or animate the atmosphere.

Apply the panel accent border/glow to:

- product navigation rail;
- expanded Filters panel;
- account/email control;
- search/action toolbar;
- applications table frame;
- pagination frame;
- billing/upgrade card where applicable.

Apply the brighter accent fill to:

- Add Application;
- the active pagination page;
- eligible Upgrade actions;
- small active indicators where green already conveys selection.

Primary actions may use a subtle accent-to-hover gradient with dark accent ink. Active
navigation/filter/pagination states use `--dash-active-fill` plus a border; they must not turn
every selected region into an opaque luminous block.

Use the lower-opacity control border for:

- search input;
- secondary buttons;
- active navigation item;
- filter selections;
- account dropdown trigger.

Use low-chroma green-gray `--dash-line` separators without glow for:

- application rows;
- filter sub-sections;
- dropdown items;
- modal content divisions;
- mobile-card internal sections.

Visual tuning may adjust surface depth, gradient positions, directional-band angle/length,
filament count within the locked two-to-three range, opacity, or the accent within a narrow
spring-green range without a plan amendment. The foundations must remain green-black rather
than blue/slate, the accent must remain vivid green rather than olive/yellow-green, and the
result must avoid a heavy neon bloom. Status, warning, error, and destructive colors retain
their semantic hues instead of being forced into the theme green.

### Typography

- Use Inter through `next/font` scoped to the dashboard route so unrelated pages are not
  restyled.
- Body and table copy: primarily 13-14px.
- Main page heading: approximately 28-32px.
- Use medium/semibold weights instead of excessive white/bright text.
- Keep numeric columns and pagination stable with tabular numerals when appropriate.

### Icons

- Use a consistent line-icon family for application, Filters, Activity, billing, search,
  add, overflow, edit, delete, close, and pagination controls.
- Decorative icons remain hidden from assistive technology.
- Icon-only controls receive an accessible label on the button itself.
- Do not render company or user-image placeholders.

### Application table

- Columns:
  1. Application;
  2. Added;
  3. Status;
  4. Salary;
  5. Notes;
  6. Actions.
- Application combines position and company, replacing two current columns without losing
  either field.
- Added uses `created_at`. It must not be labeled Applied Date because the current data model
  does not store that semantic field.
- Status continues to use the centralized real status configuration.
- Notes remain safely rendered as text, truncate in the dense row, and retain an accessible
  expansion affordance when necessary.
- Desktop row actions contain only the existing Edit and Delete functions.
- Current server/default ordering remains unchanged; no sort indicator is rendered.
- Page size remains ten; pagination adds accurate `Showing X-Y of Z applications` copy but no
  selector.

## Research-backed tooling decision

### Keep: Next.js 14, React 18, and Tailwind CSS 3.4

The existing stack can produce the layout without a framework migration. Tailwind's
responsive modifiers support the required adaptive behavior, and its existing utilities can
consume semantic CSS variables.

- [Tailwind CSS v3 responsive design](https://v3.tailwindcss.com/docs/responsive-design)
- [Tailwind CSS v3 dark mode](https://v3.tailwindcss.com/docs/dark-mode)

Do not upgrade Tailwind or Next.js in this redesign.

### Use: `next/font`

Use page-scoped Inter for the dashboard. Next.js 14 can optimize and self-host the font,
avoiding browser requests to Google and reducing layout shift.

- [Next.js 14 Pages Router font optimization](https://nextjs.org/docs/14/pages/building-your-application/optimizing/fonts)

### Add: `lucide-react`

Lucide provides consistent, customizable, tree-shakeable React SVG components. Import only
the icons used by the dashboard.

- [Lucide for React](https://lucide.dev/guide/react)
- [Lucide React accessibility](https://lucide.dev/guide/react/advanced/accessibility)

### Add narrowly: Radix Dropdown Menu

Use the Radix dropdown-menu primitive for desktop row actions and, if it reduces duplicate
custom behavior, the profile dropdown. Radix is unstyled and supplies focus management,
keyboard interaction, and ARIA behavior.

- [Radix Primitives introduction](https://www.radix-ui.com/primitives/docs/overview/introduction)
- [Radix accessibility](https://www.radix-ui.com/primitives/docs/overview/accessibility)

Prefer the individual dropdown-menu package unless bundle analysis shows the tree-shakeable
aggregate `radix-ui` package is a better fit. Do not migrate existing dialogs in the same
chunk solely for library consistency.

### Defer: TanStack Table

TanStack Table is a capable headless state engine, but the approved design excludes sorting,
column visibility, and new table state. Migrating the current table would add risk without a
user-visible benefit.

- [TanStack Table overview](https://tanstack.com/table/latest/docs/overview)

### Follow-up option: Playwright visual comparisons

Playwright can maintain screenshot baselines with `toHaveScreenshot()`, but stable baselines
must run in a consistent browser/OS environment. Adding Playwright is a separate testing
infrastructure decision, not part of the initial redesign file budget.

The project-scoped Playwright MCP server approved in Amendment 6 is narrower than that deferred
test infrastructure. It may drive the local browser and collect interactive snapshots,
screenshots, viewport, keyboard, console, and network evidence under
`docs/UIDesign/playwright-mcp-qa-runbook.md`. It does not add `@playwright/test`, test specs,
baselines, CI jobs, authenticated fixtures, or remote-mutation authority.

- [Playwright visual comparisons](https://playwright.dev/docs/test-snapshots)
- [Playwright accessibility testing](https://playwright.dev/docs/accessibility-testing)

## Component architecture

```text
Dashboard page
├── authentication and route protection
├── useJobs and filter state
├── billing entry decision and overlay collision guards
├── DashboardShell
│   ├── DashboardNavigation
│   │   ├── TrackTheApp wordmark
│   │   ├── Applications current section
│   │   ├── Filters disclosure
│   │   ├── Activity disclosure
│   │   └── Upgrade / Manage plan entry
│   ├── JobStatsSidebar / responsive Filters panel
│   └── dashboard workspace
│       ├── DashboardToolbar
│       │   ├── page heading and subtitle
│       │   ├── company search
│       │   ├── account dropdown
│       │   └── Add Application
│       ├── storage and archive states
│       ├── add form / errors / empty state
│       ├── JobTable (desktop)
│       │   └── JobTableRow
│       │       └── JobActionsMenu
│       ├── JobCardMobile (tablet/mobile)
│       └── pagination
├── ActivityDrawer
├── UpgradePlanModal
├── EditModal
└── DeleteModal
```

`src/pages/index.js` remains responsible for data and workflow orchestration. Presentational
shell, toolbar, navigation, and row-menu logic move into focused modules so the page does not
grow into a single styling-heavy component.

Every new function and internal helper must receive the short comment block required by
`AGENTS.md`, including purpose, reason, key parameters, and important side effects.

## File budget

Work outside this table requires an approved amendment.

| File | Change | Est. LOC | New file? / justification |
|---|---|---:|---|
| `package.json` | Add approved icon and dropdown-menu dependencies | ~4 | No |
| `package-lock.json` | Lock dependency graph | generated | No |
| `tailwind.config.js` | Semantic dashboard colors, font, shadow, and wide breakpoint | ~35 | No |
| `src/client/styles/globals.css` | Scoped dashboard tokens, color scheme, focus/reduced-motion helpers | ~70 | No |
| `src/pages/index.js` | Retain orchestration; compose the new shell and disclosure state | ~120 changed | No |
| `src/client/components/dashboard/DashboardShell.jsx` | Responsive grid and workspace geometry | ~100 | Yes: focused layout responsibility |
| `src/client/components/dashboard/DashboardNavigation.jsx` | Brand, approved controls, billing entry, responsive rail | ~170 | Yes: focused navigation responsibility |
| `src/client/components/dashboard/DashboardToolbar.jsx` | Heading, search, account, and Add Application | ~130 | Yes: focused toolbar responsibility |
| `src/client/components/dashboard/JobActionsMenu.jsx` | Accessible desktop Edit/Delete menu | ~110 | Yes: reusable row-action responsibility |
| `src/client/components/JobStatsSidebar.jsx` | Docked/collapsible panel plus drawer presentation | ~180 changed | No |
| `src/client/components/JobTable.jsx` | New desktop column structure and frame | ~60 changed | No |
| `src/client/components/JobTableRow.jsx` | Dense row, Added date, status, notes, row menu | ~120 changed | No |
| `src/client/components/JobCardMobile.jsx` | Dark responsive cards and Added date | ~70 changed | No |
| `src/client/components/NextPageButton.js` | Count copy, dark pagination frame, accessible labels | ~90 changed | No |
| `src/client/components/ProfileDropdown.jsx` | Email-only dark account menu | ~75 changed | No |
| `src/client/components/JobForm.jsx` | Emerald-dark dashboard form surface and actions | ~35 changed | No |
| `src/client/components/forms/JobFormFields.jsx` | Emerald-dark inputs, labels, errors, and focus states | ~55 changed | No |
| `src/client/components/EditModal.jsx` | Raised dark-emerald dialog surface | ~40 changed | No |
| `src/client/components/DeleteModal.jsx` | Dark-emerald destructive confirmation surface | ~35 changed | No |
| `src/client/components/ActivityDrawer.jsx` | Dark-emerald drawer and accent boundary treatment | ~80 changed | No |
| `src/client/components/ActivityCalendar.jsx` | Dark-emerald calendar cells and selected-date treatment | ~60 changed | No |
| `src/client/components/InfoTooltip.jsx` | Emerald-dark accessible tooltip styling | ~25 changed | No |
| `src/client/components/StorageDowngradeBanner.jsx` | Emerald-dark warning treatment preserving semantics | ~30 changed | No |
| `src/client/components/LockedArchivePanel.jsx` | Emerald-dark archive states and destructive dialog | ~100 changed | No |
| `src/client/components/UpgradePlanModal.jsx` | Emerald-dark dashboard upgrade modal styling | ~75 changed | No |
| `src/client/components/skeletons/Skeleton.jsx` | Emerald-dark skeleton primitive if necessary | ~15 changed | No |
| `src/client/components/skeletons/DashboardSkeleton.jsx` | Mirror new shell and billing skeleton position | ~170 changed | No |
| `src/shared/constants/statuses.js` | Add dashboard-dark status presentation mappings if needed | ~35 | No |
| `src/__tests__/pages/index.test.js` | Preserve billing tests; assert redesigned control wiring | ~120 changed | No |
| `src/client/components/__tests__/JobStatsSidebar.test.js` | Collapse, filter preservation, clear, focus behavior | ~140 changed | No |
| `src/client/components/__tests__/JobTableRow.test.js` | Date/status/notes/menu action behavior | ~160 | Yes: risky row interaction coverage |
| `src/client/components/__tests__/JobTable.test.js` | Desktop/mobile structure and excluded columns | ~100 | Yes: table contract coverage |
| `src/client/components/__tests__/NextPageButton.test.js` | Count math, boundaries, accessible labels | ~100 | Yes: pagination contract coverage |
| `src/client/components/__tests__/ProfileDropdown.test.js` | No avatar; email, Admin, Sign Out behavior | ~60 changed | No |
| `src/client/components/skeletons/__tests__/DashboardSkeleton.test.js` | New shell and stable billing placeholder | ~70 changed | No |
| `docs/feature-memory.md` | Brief completed-feature entry | ~8 | No; required by `AGENTS.md` |
| `docs/fixes.md` | Issue/approach/fix note immediately before push | ~8 | No; required by `AGENTS.md` |

The estimates are budgets, not targets. Prefer smaller patches and reuse existing utilities.
If a listed component needs no styling change after scoped tokens are applied, leave it
untouched and report the reduced scope.

## Test plan

### Unit and page integration

- Preserve all existing `src/__tests__/pages/index.test.js` billing-entry assertions.
- Verify Filters, Activity, account, billing, tooltip, and Add Application remain wired.
- Verify the docked Filters close control collapses the panel.
- Verify the Filters trigger reopens the panel.
- Verify collapse does not reset status, salary, search, or selected-date state.
- Verify Clear All Filters remains the only filter reset.
- Verify the upgrade modal never opens over an active focus-owning overlay.
- Verify row-menu Edit calls `onEdit(job)`.
- Verify row-menu Delete calls `onDelete(job.id)`.
- Verify the action trigger is disabled or guarded during deletion.
- Verify `created_at` renders as Added and missing dates use a safe fallback.
- Verify the real centralized status labels render.
- Verify long notes retain expansion/collapse behavior.
- Verify pagination start/end copy on first, middle, and final pages.
- Verify ProfileDropdown renders no image/avatar and preserves Admin/Sign Out.
- Verify forbidden mock controls and TrackerPro text are absent.
- Verify skeleton structure matches the redesigned shell and keeps billing loading
  non-interactive.

### Targeted commands

Exact paths may be narrowed as chunks land:

```powershell
npm test -- --runInBand src/__tests__/pages/index.test.js
npm test -- --runInBand src/client/components/__tests__/JobStatsSidebar.test.js
npm test -- --runInBand src/client/components/__tests__/JobTable.test.js
npm test -- --runInBand src/client/components/__tests__/JobTableRow.test.js
npm test -- --runInBand src/client/components/__tests__/NextPageButton.test.js
npm test -- --runInBand src/client/components/__tests__/ProfileDropdown.test.js
npm test -- --runInBand src/client/components/skeletons/__tests__/DashboardSkeleton.test.js
npm run test:unit
npm run build
```

If build preflight reports missing runtime configuration, do not inspect `.env`; report the
missing process-environment requirement and use the approved validation path.

### Manual interaction matrix

Test at minimum:

- 320x640;
- 390x844;
- 768x1024;
- 1024x768;
- 1280x800;
- 1400x900;
- approximately 1492x1055;
- 1536x864;
- 200% and 400% browser zoom where practical.

For each relevant viewport:

1. Confirm no page-level horizontal overflow outside an intentional data-table region.
2. Open and close Filters.
3. Apply a status filter, collapse Filters, reopen it, and confirm state remains selected.
4. Apply salary filters and company search, collapse/reopen, and confirm state remains.
5. Clear filters and confirm table/pagination reset correctly.
6. Open and close Activity and select/remove dates.
7. Open Add Application, submit validation errors, cancel, and complete a mocked/safe add.
8. Open Edit and Delete, verify focus containment/return, and cancel.
9. Open the account menu and verify email, optional Admin, and Sign Out.
10. Exercise Upgrade/Manage plan states using existing test fixtures or safe local mocks.
11. Inspect warning, archive, empty, loading, and API error states.
12. Confirm no excluded mock controls appear.

### Keyboard and accessibility checks

- Tab order follows the visual hierarchy.
- Every icon-only button has a useful accessible name.
- Enter and Space activate buttons.
- Escape closes menus, drawers, and dialogs as appropriate.
- Arrow-key behavior in the Radix action menu works.
- Focus returns to the originating control after overlays close.
- Focus rings use the vivid spring-green token and remain clearly visible.
- Collapsed/offscreen content is not keyboard-focusable or exposed as an active dialog.
- Status is never communicated by color alone; visible text remains present.
- Automated accessibility checks supplement but do not replace manual keyboard and screen
  reader review.

### Visual acceptance

- Compare the signed-in dashboard beside the supplied reference near 1492px width.
- Confirm the foundations are near-black emerald rather than the superseded blue/slate.
- Confirm the accent is vivid spring green rather than olive or yellow-green.
- Confirm major panel borders are clearly visible at 100% zoom.
- Confirm glow is restrained and does not create a fuzzy neon halo.
- Confirm internal row separators remain low-chroma green-gray and do not glow.
- Confirm the static CSS directional light field is visible in the upper-center/right near the
  reference viewport, uses one broad band plus no more than three subtle filaments, fades before
  the main table body, and remains subordinate to content.
- Confirm the background uses no screenshot, forest, particles, noise, representational
  scenery, generated artwork, animation, or component-local copies of the light field.
- Confirm panel radii, density, spacing, and typography resemble the reference.
- Confirm collapsed Filters produces a deliberate expanded workspace, not an empty gap.
- Confirm the page remains readable at every responsive target.

## Security surfaces

- [x] Auth/ownership: protected-route and user-owned job flows remain unchanged.
- [ ] Rate limiting: no change.
- [x] Billing/entitlement: visual relocation only; preserve fail-closed entry decisions,
  loading skeleton, modal collision guards, and canonical Billing fallback.
- [ ] Migrations: no change.
- [x] Input validation: preserve existing job form and server-side Zod boundaries.

Security constraints:

- Do not add client-side access to secrets or environment variables.
- Do not read or log `.env` files.
- Do not weaken protected-route checks.
- Do not interpolate unsanitized content into HTML.
- Preserve DOMPurify company-search sanitization and existing job validation.
- Keep Delete and archive deletion behind their existing confirmation paths.
- Keep billing and storage decisions sourced from canonical application state.

## Chunks

### Chunk 1: Design foundation

Scope:

- add approved Lucide and Radix dropdown-menu dependencies;
- add dashboard-scoped Inter;
- define semantic dashboard color, border, glow, radius, typography, focus, and motion tokens;
- add the approximately 1400px wide breakpoint;
- create DashboardShell;
- establish the CSS-only emerald-black canvas, root-owned directional light field, vignette,
  and major panel boundary primitives.

Tests/verification:

- dependency install/build smoke check;
- semantic token/contrast calculation;
- DashboardShell unit coverage where behavior exists;
- manual canvas, directional-light-field, and three-column geometry check.

Exit criteria:

- no unrelated route is restyled;
- wide and compact shell geometry works;
- emerald surface and spring-green accent tokens are centralized;
- the static directional light field is root-owned, non-interactive, and responsive;
- reduced-motion behavior is defined.

### Chunk 2: Navigation and collapsible Filters

Scope:

- create DashboardNavigation;
- move the existing billing entry into the approved navigation/upgrade area;
- refactor JobStatsSidebar into docked wide and drawer compact modes;
- implement wide collapse/reopen behavior;
- preserve all filter state and Clear All Filters behavior;
- apply the dark-emerald surface and spring-green boundary hierarchy to navigation and Filters;
- retain Activity drawer wiring.

Tests/verification:

- existing billing-entry page tests;
- new collapse/reopen/filter-preservation tests;
- overlay collision tests;
- keyboard/focus-return tests;
- viewport checks at 1280, 1400, and 1492 widths.

Exit criteria:

- wide Filters begins expanded and can collapse;
- workspace expands into the released column;
- compact Filters remains an accessible drawer;
- collapsing never changes query/filter state;
- billing behavior remains fail-closed.

### Chunk 3: Workspace toolbar, table, and pagination

Scope:

- create DashboardToolbar;
- move company search into the toolbar;
- render Add Application as the single spring-green primary action;
- restyle the email-only account dropdown;
- restructure JobTable and JobTableRow;
- add the accessible desktop Edit/Delete action menu;
- preserve mobile direct actions;
- restyle pagination and add accurate result-range copy.

Tests/verification:

- toolbar control-wiring page tests;
- table/row/action-menu tests;
- pagination boundary tests;
- excluded-control assertions;
- keyboard action-menu checks;
- responsive table/card switch checks.

Exit criteria:

- only existing data/actions are visible;
- table matches the reference density without company images;
- no sorting, column, export, or page-size control appears;
- mobile actions remain easy to target.

### Chunk 4: Forms, overlays, and conditional states

Scope:

- restyle JobForm and shared fields;
- restyle Edit and Delete dialogs;
- restyle Activity drawer/calendar;
- restyle InfoTooltip;
- restyle storage downgrade warning and locked archive panel/dialog;
- restyle UpgradePlanModal;
- restyle loading, empty, error, and no-result states;
- ensure z-index, focus, and backdrop hierarchy remains correct.

Tests/verification:

- existing focused component suites;
- modal/drawer keyboard checks;
- destructive action double-submit guards;
- storage and billing state fixture review;
- contrast checks for warning/error/destructive colors.

Exit criteria:

- no opened dashboard state falls back to the old light design;
- existing safety guards remain intact;
- status/warning/error meaning is not communicated by color alone.

### Chunk 5: Skeleton, responsive polish, and accessibility

Scope:

- rebuild DashboardSkeleton to match the final shell;
- preserve the billing-entry loading placeholder;
- tune responsive breakpoints, truncation, and card density;
- tune emerald surfaces, spring-green border/glow, CSS atmosphere, directional-band
  angle/length/opacity, filament count, and vignette against the reference;
- apply final focus, target-size, reduced-motion, reflow, and contrast fixes.

Tests/verification:

- skeleton unit tests;
- full responsive manual matrix;
- keyboard-only pass;
- screen-reader structure review;
- automated accessibility scan if approved tooling is available;
- side-by-side reference comparison.

Exit criteria:

- no material layout shift from skeleton to dashboard;
- 320px reflow retains all functionality;
- surfaces, CSS background, directional light field, borders, and glow meet the locked
  reference treatment;
- WCAG AA contrast and target-size requirements pass.

### Chunk 6: Full regression, documentation, and Gate 2

Scope:

- run targeted and full unit suites;
- run production build;
- review the final diff for unauthorized scope;
- confirm no hardcoded secrets, logger regressions, or validation changes;
- update `docs/feature-memory.md`;
- prepare the issue/approach/fix entry for `docs/fixes.md` before push;
- capture final manual verification evidence;
- stop at Gate 2 for Will's pre-PR approval.

Tests/verification:

- all targeted Jest commands;
- `npm run test:unit`;
- `npm run build`;
- final responsive, accessibility, and reference comparison;
- `git diff --check`;
- review `git status --short`.

Exit criteria:

- all required checks pass or limitations are explicitly documented;
- only approved files and dependencies changed;
- Gate 2 evidence is ready for Will's review;
- no push occurs without the required `docs/fixes.md` update.

## Chunk sequencing and rollback boundaries

- Chunks are sequential because each builds on the dashboard tokens and shell.
- Each chunk should remain reviewable and testable before the next begins.
- Chunk 1 can be rolled back by removing the two dependencies and new shell/tokens.
- Chunk 2 can be rolled back to the existing toolbar buttons and drawer without data changes.
- Chunk 3 can be rolled back to the current table/row/card components without API changes.
- Chunk 4 is presentation-only and can be reverted component by component.
- Chunk 5 is presentation/test-only and can be reverted without affecting stored data.
- No chunk includes a migration or irreversible data operation.

## Risks and mitigations

### Existing dirty worktree

`src/pages/index.js` and `src/__tests__/pages/index.test.js` already contain uncommitted
billing-entry skeleton work. Those changes belong to the current worktree and must be
preserved. Implementation should begin by re-reading the relevant diffs and should not use
reset/checkout operations.

### Wide-layout density

The reference allocates roughly 500px to navigation and Filters. Docking both at smaller
desktop widths would make the application table unreadable. Mitigation: dock Filters only at
the wide breakpoint and use the drawer below it.

### Collapse and accessibility state

CSS-only visibility can leave hidden controls exposed to keyboard or assistive technology.
Mitigation: disclosure state controls rendering/inertness as well as visual transforms, and
tests cover focusability after close.

### Emerald visual treatment

Using the spring green at full opacity on every boundary would create visual noise and could
reduce status-color distinction. Mitigation: use the locked accent with tiered alpha, reserve
accent borders for major structures, keep internal separators low-chroma green-gray, and
retain semantic status hues. Reproducing the generated background art would also add an
unnecessary asset and scale poorly; build the color atmosphere and abstract directional light
field only from static scoped CSS. Keep it root-owned and low-opacity so component surfaces,
focus indicators, and semantic colors remain dominant.

### Compact action menus

Moving Edit/Delete behind a menu adds one desktop click and creates keyboard/focus
requirements. Mitigation: use an accessible primitive, retain direct mobile buttons, and
test keyboard interaction and focus return.

### Billing regressions

Relocating Upgrade/Manage plan could accidentally bypass loading or overlay guards.
Mitigation: keep billing decisions in `src/pages/index.js`, pass a presentation contract to
navigation, and preserve the existing page integration tests before styling changes.

### Scope spread across conditional states

An emerald-dark shell around light or blue/slate forms and modals would look incomplete.
Mitigation: Chunk 4
explicitly budgets every dashboard-local conditional surface while excluding unrelated
routes.

### Dependency expansion

New libraries increase lockfile and maintenance surface. Mitigation: add only Lucide and the
smallest Radix package needed, use explicit imports, and defer table/E2E frameworks.

## Rollback

The redesign is client-presentation work with no database or API changes. Rollback consists
of reverting the dashboard component, styling, dependency, and test changes from the
implementation branch. Remove added packages from `package.json` and regenerate the lockfile
through the normal package manager if the icon/menu approach is abandoned. Existing job,
auth, billing, and storage data remains unaffected.

## Gate 1 decision defaults

Unless Will amends them before implementation, approval of this plan authorizes these design
defaults:

- dashboard-only emerald-noir styling with a static CSS-gradient background, one root-owned
  upper-center/right directional light field, and a vignette;
- text-only `TrackTheApp` wordmark;
- Filters docked open by default at approximately 1400px and collapsible;
- Filters as a drawer below the wide breakpoint;
- green-black foundations centered on `#020F0D`/`#061F18` and a spring-green accent centered
  on `#5DDA70`, with tiered opacity and restrained localized glow;
- Inter scoped to the dashboard;
- Lucide icons;
- Radix dropdown menu only where needed;
- desktop Edit/Delete overflow menu and direct mobile actions;
- Added mapped to `created_at`;
- fixed ten-row pagination;
- no mock-only features, controls, background screenshots, or generated decorative artwork.

## Amendments

| # | Date | Change | Approved by Will? |
|---|---|---|---|
| 1 | 2026-07-28 | Require the Filters panel to be collapsible without clearing filter state | Yes |
| 2 | 2026-07-28 | Add the bright leafy-green border and restrained glow treatment around major panels | Yes |
| 3 | 2026-07-28 | Supersede the blue/slate colorway with the emerald-noir palette and CSS-only atmospheric background; retain the existing layout and product scope | Yes |
| 4 | 2026-07-28 | Add one static, root-owned CSS directional light field with a broad upper-center/right band and two or three subtle filaments; keep scenery, generated assets, component-local copies, and animation excluded | Yes |
| 5 | 2026-07-29 | Approve Gate 1 and the exact Chunk 1 edit and validation scope | Yes |
| 6 | 2026-07-30 | Approve pinned, project-scoped Playwright MCP as interactive local UI QA tooling with ignored evidence output, disabled unsafe/file-transfer tools, no application dependency, no durable E2E/visual-regression infrastructure, and no remote-mutation authority | Yes |
| 7 | 2026-08-02 | Approve Chunk 4 file-budget additions for the shared overlay accessibility hook, a dashboard-scoped PlanUpgradeCard appearance, their focused tests, and focused JobForm/EditModal/DeleteModal/ActivityDrawer coverage; also approve correcting stale help copy while preserving the already-landed salary-filtered empty-state fix | Yes |
