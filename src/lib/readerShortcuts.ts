interface ShortcutActions {
  previous: () => void;
  next: () => void;
  decreaseText: () => void;
  increaseText: () => void;
  toggleOutline: () => void;
  openSearch: () => void;
  closePanel: () => void;
  typography: boolean;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") return false;
  const element = target as Element;
  return typeof element.closest === "function"
    && Boolean(element.closest("input, textarea, select, button, [contenteditable='true']"));
}

export function handleReaderShortcut(event: KeyboardEvent, actions: ShortcutActions): boolean {
  if (event.defaultPrevented || event.isComposing) return false;
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f") {
    event.preventDefault();
    actions.openSearch();
    return true;
  }
  if (event.ctrlKey || event.altKey || event.metaKey) return false;
  const editable = isEditableTarget(event.target);
  if (editable && event.key !== "Escape") return false;

  let action: (() => void) | undefined;
  if (event.key === "ArrowLeft" || event.key === "PageUp" || (event.key === " " && event.shiftKey)) action = actions.previous;
  else if (event.key === "ArrowRight" || event.key === "PageDown" || event.key === " ") action = actions.next;
  else if (event.key === "[" && actions.typography) action = actions.decreaseText;
  else if (event.key === "]" && actions.typography) action = actions.increaseText;
  else if (event.key.toLowerCase() === "t") action = actions.toggleOutline;
  else if (event.key === "Escape") action = actions.closePanel;

  if (!action) return false;
  event.preventDefault();
  action();
  return true;
}
