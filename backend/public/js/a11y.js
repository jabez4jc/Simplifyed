/**
 * Accessibility bootstrap.
 *
 * The dashboard builds most of its UI by writing HTML strings into innerHTML, across ~50 view
 * modules. Fixing accessibility by editing each of those call sites means fixing it once per
 * site and then again for every screen someone adds later. These four rules are applied to the
 * live DOM instead, and re-applied whenever a view re-renders, so they hold for markup that does
 * not exist yet.
 *
 * What is fixed here is deliberately mechanical - naming controls, making them focusable,
 * moving focus into dialogs. Anything needing a judgement call about the interface belongs in
 * the markup, not in a sweep like this.
 */

(function initAccessibility() {
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"])';

  /**
   * 1. Name every control that only shows an icon.
   *
   * `title` is a tooltip, not an accessible name: it is not announced reliably by screen readers
   * and never surfaces on touch. Every one of these buttons already carries the right words in
   * its title - they just were not exposed to assistive technology.
   */
  function nameIconOnlyControls(root) {
    root.querySelectorAll('button[title], a[title][role="button"]').forEach((el) => {
      if (el.getAttribute('aria-label')) return;
      const text = (el.textContent || '').trim();
      const hasReadableText = /[a-z0-9]/i.test(text);
      if (hasReadableText) return;
      const title = el.getAttribute('title');
      if (title) el.setAttribute('aria-label', title);
    });
  }

  /**
   * 2. Put the navigation in the tab order.
   *
   * The nav items are <a> elements with an onclick and no href. An anchor without href is not
   * focusable, so the entire application was unreachable by keyboard - not awkward to use,
   * genuinely unreachable. Giving them a button role, a tab stop and Enter/Space activation is
   * the smallest change that does not disturb the existing click wiring.
   */
  function makeNavKeyboardOperable(root) {
    root.querySelectorAll('a[data-view]:not([href])').forEach((el) => {
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
      if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
    });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (!target.matches('a[data-view]:not([href]), [role="button"]:not(button):not([href])')) return;
    event.preventDefault();
    target.click();
  });

  /**
   * 3. Move focus into a dialog when it opens.
   *
   * Without this the modal appears but focus stays on the page behind it, so a keyboard user
   * tabs through the obscured page instead of the form they just opened.
   */
  function focusDialog(modal) {
    if (modal.dataset.a11yFocused) return;
    modal.dataset.a11yFocused = '1';

    if (!modal.getAttribute('role')) modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    const first = modal.querySelector(FOCUSABLE);
    if (first) {
      // Let the browser finish laying the modal out before taking focus.
      requestAnimationFrame(() => first.focus({ preventScroll: true }));
    }
  }

  /** 4. Re-apply to anything a view renders after the initial load. */
  function apply(root = document) {
    nameIconOnlyControls(root);
    makeNavKeyboardOperable(root);
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        apply(node);
        if (node.classList.contains('modal-overlay')) focusDialog(node);
        node.querySelectorAll?.('.modal-overlay').forEach(focusDialog);
      }
    }
  });

  function start() {
    apply(document);
    document.querySelectorAll('.modal-overlay').forEach(focusDialog);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
