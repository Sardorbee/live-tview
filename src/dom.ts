/** True when a key press is going into a text field or the code editor, so global shortcuts should stay out of the way. */
export const isTyping = (e: Event) => !!(e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"], .cm-editor');
