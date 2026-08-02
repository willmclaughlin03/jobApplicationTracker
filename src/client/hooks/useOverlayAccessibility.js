import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTORS = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

const overlayStack = [];
const documentRegistrationCounts = new Map();
const bodyScrollLocks = new Map();

/**
 * Determine whether an element remains a safe programmatic focus target.
 *
 * Purpose: focus should never return into disconnected, disabled, inert, hidden,
 * or visually suppressed UI after an overlay closes.
 *
 * @param {Element|null} element - Candidate initial or return-focus element.
 * @returns {boolean} Whether focus can safely move to the element.
 */
function isFocusableElement(element) {
  if (
    !element
    || !element.isConnected
    || typeof element.focus !== 'function'
    || typeof element.matches !== 'function'
  ) {
    return false;
  }

  if (
    element.matches('[hidden], :disabled, input[type="hidden"]')
    || element.closest('[hidden], [inert], [aria-hidden="true"]')
  ) {
    return false;
  }

  const ownerWindow = element.ownerDocument?.defaultView;
  const styles = ownerWindow?.getComputedStyle?.(element);
  if (styles?.display === 'none' || styles?.visibility === 'hidden') {
    return false;
  }

  return element.matches(FOCUSABLE_SELECTORS) || element.tabIndex >= 0;
}

/**
 * Collect the currently usable Tab stops inside one overlay panel.
 *
 * Purpose: dynamic disabled and hidden states can change while an overlay is
 * open, so the focus trap must inspect the live DOM for every Tab press.
 *
 * @param {HTMLElement} container - Active focus-owning overlay panel.
 * @returns {HTMLElement[]} Ordered live Tab stops.
 */
function getFocusableElements(container) {
  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTORS))
    .filter(isFocusableElement);
}

/**
 * Find the newest active overlay registered in one document.
 *
 * Purpose: independently rendered drawers and dialogs share a module stack,
 * while document scoping prevents one document from handling another's keys.
 *
 * @param {Document} ownerDocument - Document receiving the keyboard event.
 * @returns {object|null} Top registration for that document.
 */
function getTopOverlay(ownerDocument) {
  for (let index = overlayStack.length - 1; index >= 0; index -= 1) {
    if (overlayStack[index].ownerDocument === ownerDocument) {
      return overlayStack[index];
    }
  }

  return null;
}

/**
 * Process keyboard input for only the top focus-owning overlay.
 *
 * Purpose: one capture listener per document prevents a single Escape press
 * from reaching underlying overlays and keeps Tab inside the active panel.
 *
 * @param {KeyboardEvent} event - Captured document keyboard event.
 * @returns {void}
 */
function handleOverlayKeyDown(event) {
  const ownerDocument = event.currentTarget;
  const registration = getTopOverlay(ownerDocument);
  if (!registration) {
    return;
  }

  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    registration.requestClose();
    return;
  }

  if (event.key !== 'Tab') {
    return;
  }

  const { container } = registration;
  const focusableElements = getFocusableElements(container);
  if (focusableElements.length === 0) {
    event.preventDefault();
    container.focus();
    return;
  }

  const firstElement = focusableElements[0];
  const lastElement = focusableElements[focusableElements.length - 1];
  const activeElement = ownerDocument.activeElement;
  const focusNeedsEntry = activeElement === container || !container.contains(activeElement);

  if (event.shiftKey && (focusNeedsEntry || activeElement === firstElement)) {
    event.preventDefault();
    lastElement.focus();
  } else if (!event.shiftKey && (focusNeedsEntry || activeElement === lastElement)) {
    event.preventDefault();
    firstElement.focus();
  }
}

/**
 * Lock one document body's scroll while preserving its prior inline overflow.
 *
 * Purpose: nested overlays share one counted lock so closing an upper surface
 * cannot unlock the page beneath a still-open focus owner.
 *
 * @param {HTMLElement} body - Owner document body to lock.
 * @returns {void}
 */
function lockBodyScroll(body) {
  const existingLock = bodyScrollLocks.get(body);
  if (existingLock) {
    existingLock.count += 1;
    return;
  }

  bodyScrollLocks.set(body, {
    count: 1,
    previousOverflow: body.style.overflow,
  });
  body.style.overflow = 'hidden';
}

/**
 * Release one counted body-scroll lock and restore the original inline value.
 *
 * Purpose: the final overlay cleanup owns restoration, including unmount and
 * React Strict Mode setup-cleanup cycles.
 *
 * @param {HTMLElement} body - Owner document body whose lock is released.
 * @returns {void}
 */
function unlockBodyScroll(body) {
  const existingLock = bodyScrollLocks.get(body);
  if (!existingLock) {
    return;
  }

  existingLock.count -= 1;
  if (existingLock.count > 0) {
    return;
  }

  body.style.overflow = existingLock.previousOverflow;
  bodyScrollLocks.delete(body);
}

/**
 * Register one open overlay and return its idempotent cleanup.
 *
 * Purpose: registration coordinates the shared focus stack, document listener,
 * body lock, and focus return across independently rendered overlay components.
 *
 * @param {object} registration - Panel, document, origin, and latest-close bridge.
 * @returns {Function} Cleanup for close, unmount, or Strict Mode replay.
 */
function registerOverlay(registration) {
  const { ownerDocument } = registration;
  const registrationCount = documentRegistrationCounts.get(ownerDocument) || 0;

  overlayStack.push(registration);
  if (registrationCount === 0) {
    ownerDocument.addEventListener('keydown', handleOverlayKeyDown, true);
  }
  documentRegistrationCounts.set(ownerDocument, registrationCount + 1);
  lockBodyScroll(ownerDocument.body);

  let isRegistered = true;

  return () => {
    if (!isRegistered) {
      return;
    }
    isRegistered = false;

    const wasTopOverlay = getTopOverlay(ownerDocument) === registration;
    const registrationIndex = overlayStack.indexOf(registration);
    if (registrationIndex >= 0) {
      overlayStack.splice(registrationIndex, 1);
    }

    const nextCount = (documentRegistrationCounts.get(ownerDocument) || 1) - 1;
    if (nextCount === 0) {
      ownerDocument.removeEventListener('keydown', handleOverlayKeyDown, true);
      documentRegistrationCounts.delete(ownerDocument);
    } else {
      documentRegistrationCounts.set(ownerDocument, nextCount);
    }

    unlockBodyScroll(ownerDocument.body);

    if (wasTopOverlay && isFocusableElement(registration.focusOrigin)) {
      registration.focusOrigin.focus();
    }
  };
}

/**
 * Provide coordinated Escape, focus trapping/return, and scroll locking.
 *
 * Purpose: every dashboard drawer or modal joins one focus-owner stack so only
 * the top surface handles keyboard input and the page unlocks after the final
 * surface closes.
 *
 * @param {boolean} isOpen - Whether the overlay is currently visible.
 * @param {Function} onClose - Latest callback used to close the overlay.
 * @returns {{ containerRef: React.RefObject }} Ref for the overlay panel.
 */
export function useOverlayAccessibility(isOpen, onClose) {
  const containerRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const container = containerRef.current;
    if (!container) {
      return undefined;
    }

    const ownerDocument = container.ownerDocument;
    const unregisterOverlay = registerOverlay({
      container,
      ownerDocument,
      focusOrigin: ownerDocument.activeElement,
      requestClose: () => onCloseRef.current(),
    });
    const initialFocusTarget = getFocusableElements(container)[0] || container;
    initialFocusTarget.focus();

    return unregisterOverlay;
  }, [isOpen]);

  return { containerRef };
}
