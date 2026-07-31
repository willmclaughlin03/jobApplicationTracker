import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react';

/**
 * Render the compact desktop Edit/Delete menu for one application.
 *
 * Purpose: Radix supplies menu semantics, keyboard navigation, dismissal, and
 * focus return while the row keeps the existing edit and delete callbacks.
 *
 * @param {object} props - Row action presentation.
 * @param {object} props.job - Job passed unchanged to the edit callback.
 * @param {Function} props.onEdit - Existing edit callback receiving the job.
 * @param {Function} props.onDelete - Existing delete callback receiving job.id.
 * @param {boolean} props.disabled - Prevents action re-entry during deletion.
 * @returns {React.ReactElement} Accessible desktop overflow action menu.
 */
export default function JobActionsMenu({
  job,
  onEdit,
  onDelete,
  disabled = false,
}) {
  /**
   * Invoke the existing edit workflow unless deletion owns the row.
   *
   * @returns {void}
   */
  const handleEdit = () => {
    if (!disabled) {
      onEdit(job);
    }
  };

  /**
   * Invoke the existing confirmed-delete entry point exactly once per selection.
   *
   * @returns {void}
   */
  const handleDelete = () => {
    if (!disabled) {
      onDelete(job.id);
    }
  };

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={`Actions for ${job.position} at ${job.company}`}
          className="dashboard-control dashboard-focus-ring inline-flex min-h-9 min-w-9 items-center justify-center text-dashboard-muted transition-colors hover:border-dashboard-accent/60 hover:bg-dashboard-surface-hover hover:text-dashboard-text disabled:cursor-not-allowed disabled:opacity-50"
        >
          <MoreHorizontal aria-hidden="true" size={18} />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-[70] min-w-40 rounded-dashboard-panel border border-dashboard-control-border bg-dashboard-surface-raised p-1.5 text-dashboard-body text-dashboard-text shadow-xl"
        >
          <DropdownMenu.Item
            disabled={disabled}
            onSelect={handleEdit}
            className="dashboard-focus-ring flex min-h-9 cursor-pointer select-none items-center gap-2 rounded-dashboard-control px-3 py-2 outline-none data-[disabled]:pointer-events-none data-[highlighted]:bg-dashboard-surface-hover data-[disabled]:opacity-50"
          >
            <Pencil aria-hidden="true" size={16} />
            Edit
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-dashboard-line" />
          <DropdownMenu.Item
            disabled={disabled}
            onSelect={handleDelete}
            className="dashboard-focus-ring flex min-h-9 cursor-pointer select-none items-center gap-2 rounded-dashboard-control px-3 py-2 text-red-300 outline-none data-[disabled]:pointer-events-none data-[highlighted]:bg-red-500/10 data-[highlighted]:text-red-200 data-[disabled]:opacity-50"
          >
            <Trash2 aria-hidden="true" size={16} />
            Delete
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
