import type { CommentItem } from "../../types/highlight";
import type { CommentInputEditContext } from "./CommentInputView";

export interface CommentInputElements {
    card: HTMLElement;
    textarea?: HTMLTextAreaElement;
    actionHint?: HTMLElement;
    commentEl?: Element | null;
}

export function restoreOrRemoveCommentInput(
    elements: CommentInputElements,
    existingComment: CommentItem | undefined,
    editContext?: CommentInputEditContext | null
): void {
    const { card, textarea, actionHint } = elements;
    if (!textarea) return;

    if (existingComment && editContext?.contentEl && editContext?.footer) {
        textarea.replaceWith(editContext.contentEl);
        actionHint?.remove();
        editContext.footer.removeClass('hi-note-hidden');
        return;
    }

    const inputContainer = textarea.closest('.hi-note-input');
    if (inputContainer) {
        inputContainer.remove();
    }

    if (!card.querySelector('.hi-note')) {
        card.querySelector('.hi-notes-section')?.remove();
    }
}

/**
 * 关掉输入框。改批注时输入框是顶替批注正文放进去的、日期那行也藏起来了：
 * 只把输入框拿掉的话，正文和日期都没了，卡片里只剩「展开/收起」按钮，点了什么也不出来。
 * 保存后卡片会整个重画，那时输入框早已不在页面上，这里就什么都不用做；
 * 没重画（内容没变、或者没找到要重画的卡片）时，把原来的正文和日期放回去。
 */
export function removeCommentInputElements(
    elements: CommentInputElements,
    safe = false,
    editContext?: CommentInputEditContext | null
): void {
    const { textarea } = elements;
    if (textarea?.isConnected && editContext?.contentEl) {
        textarea.replaceWith(editContext.contentEl);
    }
    editContext?.footer?.removeClass('hi-note-hidden');

    removeElement(elements.textarea, safe);
    removeElement(elements.actionHint, safe);

    if (elements.commentEl && (!safe || elements.commentEl.isConnected)) {
        elements.commentEl.removeClass('editing');
    }
}

function removeElement(element: HTMLElement | undefined, safe: boolean): void {
    if (!element) return;
    if (safe && !element.isConnected) return;

    if (element.parentElement) {
        element.remove();
    }
}
