/**
 * Whether a study shortcut should handle this key event: false while the user
 * is typing, a modifier is held, the key repeats, or a dialog is open.
 */
export function isStudyKeyTarget(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.repeat || event.isComposing) return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  const target = event.target;
  if (target instanceof Element && target.closest("input, textarea, select, [contenteditable='true'], [data-ask-panel]")) {
    return false;
  }
  if (document.querySelector("[role='dialog']:not([hidden]), [role='alertdialog']:not([hidden]), dialog[open]")) return false;
  return true;
}
