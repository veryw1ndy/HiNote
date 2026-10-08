import { Platform } from "obsidian";

export interface CommentInputKeyboardOptions {
    onInlineAI: () => Promise<void>;
    onSave: () => Promise<void>;
}

/** Characters that wrap the selection when typed, instead of replacing it. */
const WRAPPING_KEYS = ['*', '_', '`', '=', '~'];

/**
 * Wraps the selection in `marker`, or unwraps it when it is already wrapped.
 *
 * The edit goes through execCommand so that it joins the textarea's own undo
 * history - assigning to .value would wipe that history, and undo is the other
 * half of what this file fixes.
 */
function surroundSelection(textarea: HTMLTextAreaElement, marker: string): boolean {
    const { selectionStart: start, selectionEnd: end, value } = textarea;
    if (start === end) return false;

    const selected = value.slice(start, end);
    const n = marker.length;
    const already =
        selected.length >= 2 * n &&
        selected.startsWith(marker) &&
        selected.endsWith(marker);

    textarea.focus();
    textarea.setSelectionRange(start, end);
    activeDocument.execCommand(
        'insertText',
        false,
        already ? selected.slice(n, -n) : marker + selected + marker
    );

    // Leave the text itself selected, so markers can be stacked: select a word,
    // press * twice, and it ends up **bold**.
    textarea.setSelectionRange(
        already ? start : start + n,
        already ? end - 2 * n : end + n
    );
    return true;
}

export function setupCommentInputKeyboard(
    textarea: HTMLTextAreaElement,
    options: CommentInputKeyboardOptions
): void {
    textarea.onkeydown = async (event: KeyboardEvent) => {
        // 输入法正在组字时（拼音、假名等），回车是用来上屏候选词的，
        // 不能当成保存；浏览器就是为此提供 isComposing 的，229 是旧写法。
        if (event.isComposing || event.keyCode === 229) return;

        // The comment box lives inside the editor, so a shortcut typed here
        // would otherwise reach CodeMirror and Obsidian's hotkeys - which is
        // why undo used to undo the NOTE. Keeping these events in the box lets
        // the textarea do its own undo, redo, select-all, cut and paste.
        if (event.metaKey || event.ctrlKey) {
            event.stopPropagation();

            if (!event.altKey) {
                const key = event.key.toLowerCase();
                if (key === 'b' && surroundSelection(textarea, '**')) {
                    event.preventDefault();
                    return;
                }
                if (key === 'i' && surroundSelection(textarea, '*')) {
                    event.preventDefault();
                    return;
                }
                if (event.shiftKey && key === 'h' && surroundSelection(textarea, '==')) {
                    event.preventDefault();
                    return;
                }
            }
            return;
        }

        // Typing a marker with text selected wraps it, rather than wiping it.
        if (WRAPPING_KEYS.includes(event.key) && surroundSelection(textarea, event.key)) {
            event.preventDefault();
            return;
        }

        if (event.key === 'Tab') {
            event.preventDefault();
            await options.onInlineAI();
            return;
        }

        if (event.key !== 'Enter') {
            return;
        }

        if (Platform.isMobile || event.shiftKey) {
            return;
        }

        event.preventDefault();
        await options.onSave();
    };
}

export function autoResizeCommentTextarea(textarea: HTMLTextAreaElement | undefined): void {
    if (!textarea) return;

    window.requestAnimationFrame(() => {
        if (!textarea) return;

        const scrollTop = window.scrollY || activeDocument.documentElement.scrollTop;

        textarea.setCssProps({ height: 'auto' });
        textarea.setCssProps({ height: `${textarea.scrollHeight}px` });

        window.scrollTo(0, scrollTop);
    });
}
