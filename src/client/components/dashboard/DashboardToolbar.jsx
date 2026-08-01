import { useEffect, useRef, useState } from 'react';
import DOMPurify from 'isomorphic-dompurify';
import { Plus, Search, X } from 'lucide-react';
import InfoTooltip from '../InfoTooltip';
import ProfileDropdown from '../ProfileDropdown';

/**
 * Render the Applications heading and existing workspace controls.
 *
 * Purpose: Keeps heading, company search, account, tooltip, and Add
 * Application presentation together while Dashboard continues to own the
 * applied search criterion and form workflow.
 *
 * @param {object} props - Page-owned toolbar state and callbacks.
 * @param {object} props.user - Authenticated user displayed by the account menu.
 * @param {Function} props.onSignOut - Existing sign-out workflow.
 * @param {string} props.searchQuery - Applied company-search criterion.
 * @param {Function} props.onSearchChange - Applies one sanitized company search.
 * @param {number} props.searchResetKey - Changes when Clear All cancels draft search work.
 * @param {boolean} props.searchDisabled - Whether company search is temporarily unavailable.
 * @param {boolean} props.addExpanded - Whether the existing add form is open.
 * @param {boolean} props.addDisabled - Whether an add/update save is in flight.
 * @param {Function} props.onAddToggle - Existing Add Application form toggle.
 * @returns {React.ReactElement} Presentational dashboard workspace toolbar.
 */
export default function DashboardToolbar({
  user,
  onSignOut,
  searchQuery,
  onSearchChange,
  searchResetKey,
  searchDisabled,
  addExpanded,
  addDisabled,
  onAddToggle,
}) {
  const [localSearch, setLocalSearch] = useState(searchQuery || '');
  const searchTimerRef = useRef(null);

  /**
   * Clear draft search work only for an explicit page-owned reset.
   *
   * Purpose: applied search updates must not overwrite a newer draft or cancel
   * its debounce; Dashboard signals invalidation by changing searchResetKey.
   *
   * @returns {void}
   */
  useEffect(() => {
    clearTimeout(searchTimerRef.current);
    setLocalSearch('');
  }, [searchResetKey]);

  /** Cancel pending company-search work when the toolbar unmounts. */
  useEffect(() => () => {
    clearTimeout(searchTimerRef.current);
  }, []);

  /**
   * Debounce and sanitize one company-search edit before applying it.
   *
   * @param {React.ChangeEvent<HTMLInputElement>} event - Toolbar search edit.
   * @returns {void}
   */
  const handleSearchChange = (event) => {
    const value = event.target.value;
    setLocalSearch(value);
    clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      onSearchChange(DOMPurify.sanitize(value, { ALLOWED_TAGS: [] }));
    }, 300);
  };

  /**
   * Clear both the visible draft and applied company-search criterion.
   *
   * @returns {void}
   */
  const handleClearSearch = () => {
    clearTimeout(searchTimerRef.current);
    setLocalSearch('');
    onSearchChange('');
  };

  return (
    <section
      aria-labelledby="applications-heading"
      className="dashboard-major-panel rounded-dashboard-panel bg-dashboard-surface/90 px-4 py-4 sm:px-5"
    >
      <div className="flex flex-col gap-4">
        <div>
          <h1
            id="applications-heading"
            className="text-2xl font-semibold tracking-tight text-dashboard-text sm:text-3xl"
          >
            Applications
          </h1>
          <p className="mt-1 text-dashboard-body text-dashboard-muted">
            Track and manage your job applications.
          </p>
        </div>

        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <div className="relative min-w-0 flex-1">
            <label htmlFor="job-search" className="sr-only">
              Search companies
            </label>
            <Search
              aria-hidden="true"
              size={17}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dashboard-muted"
            />
            <input
              id="job-search"
              type="search"
              value={localSearch}
              onChange={handleSearchChange}
              placeholder="Search companies..."
              disabled={searchDisabled}
              maxLength={100}
              className="dashboard-control dashboard-focus-ring min-h-9 w-full py-2 pl-10 pr-10 text-dashboard-body text-dashboard-text placeholder:text-dashboard-muted/70 disabled:cursor-not-allowed disabled:opacity-50"
            />
            {localSearch && (
              <button
                type="button"
                onClick={handleClearSearch}
                aria-label="Clear company search"
                className="dashboard-focus-ring absolute right-1 top-1/2 inline-flex min-h-7 min-w-7 -translate-y-1/2 items-center justify-center rounded text-dashboard-muted transition-colors hover:text-dashboard-text"
              >
                <X aria-hidden="true" size={15} />
              </button>
            )}
          </div>

          <div className="flex min-w-0 flex-wrap items-center gap-2 md:flex-nowrap">
            <ProfileDropdown user={user} onSignOut={onSignOut} />
            <InfoTooltip />
            <button
              type="button"
              onClick={onAddToggle}
              aria-expanded={addExpanded}
              disabled={addDisabled}
              className="dashboard-focus-ring inline-flex min-h-9 flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-dashboard-control border border-dashboard-accent bg-dashboard-accent px-4 py-2 text-dashboard-body font-semibold text-dashboard-accent-ink shadow-dashboard-panel transition-colors hover:bg-dashboard-accent-hover disabled:cursor-not-allowed disabled:opacity-60 sm:flex-none"
            >
              <Plus aria-hidden="true" size={17} strokeWidth={2.2} />
              {addExpanded ? 'Cancel' : 'Add Application'}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
