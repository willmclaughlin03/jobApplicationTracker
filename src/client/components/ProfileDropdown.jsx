import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, LogOut, ShieldCheck } from 'lucide-react';
import Link from 'next/link';

/**
 * Render the email-only account control and existing account actions.
 *
 * Purpose: Removes the former avatar while Radix supplies keyboard navigation,
 * outside dismissal, Escape handling, and focus return for Admin and Sign Out.
 *
 * @param {object} props - Account presentation contract.
 * @param {object} props.user - Supabase user object with email and optional role.
 * @param {Function} props.onSignOut - Existing sign-out and redirect callback.
 * @returns {React.ReactElement} Accessible account dropdown.
 */
export default function ProfileDropdown({ user, onSignOut }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={`Account menu for ${user?.email || 'current user'}`}
          className="dashboard-control dashboard-focus-ring inline-flex min-h-9 min-w-0 max-w-full items-center gap-2 px-3 py-2 text-dashboard-body font-medium text-dashboard-text transition-colors hover:border-dashboard-accent/60 hover:bg-dashboard-surface-hover sm:max-w-64"
        >
          <span className="min-w-0 truncate">{user?.email || 'Account'}</span>
          <ChevronDown aria-hidden="true" size={15} className="shrink-0" />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="dashboard-portal-theme z-[70] w-[min(18rem,calc(100vw-2rem))] rounded-dashboard-panel border border-dashboard-control-border bg-dashboard-surface-raised p-1.5 text-dashboard-body text-dashboard-text shadow-xl"
        >
          <DropdownMenu.Label className="px-3 py-2">
            <span className="block text-dashboard-caption text-dashboard-muted">Signed in as</span>
            <span className="block truncate font-medium text-dashboard-text">{user?.email}</span>
          </DropdownMenu.Label>
          <DropdownMenu.Separator className="my-1 h-px bg-dashboard-line" />

          <div>
            {user?.role === 'admin' && (
              <DropdownMenu.Item asChild>
                <Link
                  href="/admin/users"
                  className="dashboard-focus-ring flex min-h-9 cursor-pointer select-none items-center gap-2 rounded-dashboard-control px-3 py-2 text-amber-200 outline-none data-[highlighted]:bg-dashboard-surface-hover"
                >
                  <ShieldCheck aria-hidden="true" size={16} />
                  Admin
                </Link>
              </DropdownMenu.Item>
            )}

            <DropdownMenu.Item asChild>
              <button
                type="button"
                onClick={onSignOut}
                className="dashboard-focus-ring flex min-h-9 w-full cursor-pointer select-none items-center gap-2 rounded-dashboard-control px-3 py-2 text-left text-red-300 outline-none data-[highlighted]:bg-red-500/10 data-[highlighted]:text-red-200"
              >
                <LogOut aria-hidden="true" size={16} />
                Sign Out
              </button>
            </DropdownMenu.Item>
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
