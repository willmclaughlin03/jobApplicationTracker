import { useRef, useEffect } from 'react';

// Matches every element the browser's native Tab key would visit:
// - a[href]: anchors with an actual destination (no-href anchors are not focusable)
// - button/input/textarea/select: interactive controls, excluding disabled ones
// - [tabindex]:not([tabindex="-1"]): elements explicitly opted into the Tab cycle;
//   tabindex="-1" means programmatically focusable only, so those are excluded
const FOCUSABLE_SELECTORS =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Provides Escape-to-close and focus trapping for overlay elements (drawers, modals).
 *
 * Purpose: Encapsulates keyboard accessibility behaviour shared by all overlay components
 * Connects to: Any drawer or modal that renders over page content with a backdrop
 *
 * @param {boolean} isOpen - Whether the overlay is currently visible
 * @param {Function} onClose - Callback to close the overlay
 * @returns {{ containerRef: React.RefObject }} Ref to attach to the overlay panel element
 */
export function useOverlayAccessibility(isOpen, onClose) {
  const containerRef = useRef(null);
  const previousFocusRef = useRef(null);
  const onCloseRef = useRef(onClose);

  // Keep the ref current on every render so the keydown handler always calls
  // the latest onClose without it appearing in the effect's dep array.
  useEffect(() => { onCloseRef.current = onClose; });

  useEffect(() => {
    if (!isOpen) return;

    // Save the element that had focus before the overlay opened
    previousFocusRef.current = document.activeElement;

    const container = containerRef.current;
    if (!container) return;

    // Move focus into the overlay
    const focusable = Array.from(container.querySelectorAll(FOCUSABLE_SELECTORS));
    if (focusable.length > 0) {
      focusable[0].focus();
    } else {
      container.focus();
    }

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }

      if (e.key === 'Tab') {
        const focusableNow = Array.from(container.querySelectorAll(FOCUSABLE_SELECTORS));
        if (focusableNow.length === 0) {
          e.preventDefault();
          return;
        }

        const first = focusableNow[0];
        const last = focusableNow[focusableNow.length - 1];

        if (e.shiftKey) {
          // Shift+Tab on the first element — wrap to last
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          // Tab on the last element — wrap to first
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      // Restore focus to the element that triggered the overlay
      if (previousFocusRef.current && typeof previousFocusRef.current.focus === 'function') {
        previousFocusRef.current.focus();
      }
    };
  }, [isOpen]);

  return { containerRef };
}
