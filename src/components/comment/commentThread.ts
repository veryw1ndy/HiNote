import { HighlightInfo as HiNote } from "../../types/highlight";

/**
 * 有批注的高亮换一个颜色，没批注的还是默认黄色，
 * 这样翻一页笔记一眼就能分出「写过东西的」和「只是划了一道的」。
 *
 * A highlight that carries comments is tinted differently from a bare one, so
 * scanning a note separates the ones worth going back to from the rest.
 */

/** 加在高亮本身上的 class，颜色见 styles.css。 */
export const COMMENT_THREAD_CLASS = "hi-note-commented";

/**
 * 默认黄色。与 HighlightExtractor 里发给每条高亮的那个值一致 —
 * 每条高亮都存了 backgroundColor，所以不能只判断「有没有颜色」。
 */
const DEFAULT_HIGHLIGHT_COLOR = "#ffeb3b";

/**
 * 自己挑过颜色的高亮不动：那本身已经是一种分类了，盖掉等于扔了用户的选择。
 * 只有停在默认黄色上的才换。
 */
export function hasCommentThread(highlight: HiNote): boolean {
    if (!highlight.comments?.length) return false;

    const color = highlight.backgroundColor?.trim().toLowerCase();
    return !color || color === DEFAULT_HIGHLIGHT_COLOR;
}
