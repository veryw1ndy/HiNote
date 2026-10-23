import { MarkdownPostProcessorContext, TFile } from "obsidian";
import { HighlightInfo as HiNote } from "../../../types/highlight";
import { HighlightRepository } from "../../../repositories/HighlightRepository";
import { HighlightCommentResolver } from "../../../services/highlight";

export type PreviewHighlight = HiNote & { line: number };

const BLOCK_TAGS = new Set([
    'p',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'li',
    'div',
    'blockquote',
    'pre',
    'td',
    'th'
]);

/**
 * Obsidian 渲染出来的行内公式：MathJax 加载前 span 里是 TeX 原文（没有 $），
 * 加载后是 mjx-container。两种都和存下来的 $…$ 对不上。
 */
const MATH_SELECTOR = '.math, mjx-container';

/**
 * 解析阅读模式下可渲染的高亮数据。
 *
 * Preview renderer 只应该关心 DOM 渲染；这里集中处理存储匹配、评论补全和行号计算。
 */
export class PreviewHighlightResolver {
    private commentResolver: HighlightCommentResolver;

    constructor(highlightRepository: HighlightRepository) {
        this.commentResolver = new HighlightCommentResolver(highlightRepository);
    }

    enrichHighlightsWithComments(
        rawHighlights: HiNote[],
        file: TFile,
        content: string
    ): PreviewHighlight[] {
        // 不再过滤掉"还没有评论"的高亮：阅读模式下也要能对它们添加批注，
        // 否则悬停时根本没有图标可点。
        return this.commentResolver.resolveAll(file, rawHighlights)
            .map(({ highlight }) => ({
                ...highlight,
                line: this.getLineForPosition(content, highlight.position)
            }));
    }

    /**
     * 去掉行内 Markdown 标记后再比对。
     *
     * 提取出来的高亮文本是原文（==**粗体**==），而阅读模式下 <mark> 里是
     * 渲染后的纯文字（粗体），两者直接比对永远不相等 —— 所以凡是带格式的
     * 高亮在阅读模式下都找不到，只有纯文本的能用。
     */
    private plainText(value: string): string {
        return value
            // 公式整段拿掉：屏幕那边 markText() 也跳过了公式，两边才比得上。
            // 必须放在最前面，不然 TeX 里的 _ 和 * 会被下面当成斜体吃掉。
            .replace(/\$\$[\s\S]*?\$\$/g, '')
            .replace(/(?<!\\)\$[^$\n]+?(?<!\\)\$/g, '')
            .replace(/`([^`]*)`/g, '$1')
            .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
            .replace(/\*\*([^*]+)\*\*/g, '$1')
            .replace(/\*([^*]+)\*/g, '$1')
            .replace(/__([^_]+)__/g, '$1')
            .replace(/_([^_]+)_/g, '$1')
            .replace(/~~([^~]+)~~/g, '$1')
            .replace(/==([^=]+)==/g, '$1')
            .replace(/\[\[([^\]|]+)\|([^\]]*)\]\]/g, '$2')
            .replace(/\[\[([^\]]+)\]\]/g, '$1')
            .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private sameText(highlightText: string, domText: string): boolean {
        if (highlightText === domText) return true;

        // 公式拿掉以后两边的空格不一定对得上（「a $x$ b」剩「a  b」，屏幕上可能是「ab」），
        // 所以去掉全部空白再比。整条都是公式的高亮会剩空串、跟谁都相等，不算数。
        const stored = this.plainText(highlightText).replace(/\s+/g, '');
        // 整条都是公式（==$x$==）：两边都只剩空串，那就比公式本身
        if (stored === '' && this.plainText(domText).replace(/\s+/g, '') === '') {
            const formula = (s: string) => s.replace(/\$/g, '').replace(/\s+/g, '');
            return formula(highlightText) !== '' && formula(highlightText) === formula(domText);
        }
        return stored !== '' && stored === this.plainText(domText).replace(/\s+/g, '');
    }

    /**
     * <mark> 里屏幕上的文字，跳过公式和我们自己加的批注小部件。
     *
     * 直接用 textContent 的话，公式那段是 TeX 原文或 MathJax 的内部文字，
     * 带公式的高亮就永远匹配不上 —— 没有颜色，也没有悬停。
     */
    markText(mark: Element): string {
        const copy = mark.cloneNode(true) as Element;
        copy.querySelectorAll('.hi-note-widget, .hi-note-math-marks').forEach(el => el.remove());
        // 公式换回 $LaTeX$（MathJax 把原文留在 data-latex 里），整条都是公式的高亮才有字可比。
        // 拿不到 LaTeX 的就去掉，和 plainText() 一样
        copy.querySelectorAll(MATH_SELECTOR).forEach(el => {
            if (!copy.contains(el)) return; // 外面那层已经换掉了
            const latex = el.querySelector('[data-latex]')?.getAttribute('data-latex') || '';
            const display = el.matches('.math-block, mjx-container[display=true]') || !!el.querySelector('mjx-container[display=true]');
            el.replaceWith(latex ? (display ? `$$${latex}$$` : `$${latex}$`) : '');
        });
        return copy.textContent ?? '';
    }

    findMatchingHighlight(
        text: string,
        mark: Element,
        rootElement: HTMLElement,
        context: MarkdownPostProcessorContext,
        highlightsWithComments: PreviewHighlight[]
    ): PreviewHighlight | null {
        const sectionInfo = this.getSectionInfo(mark, rootElement, context);
        const sameText = highlightsWithComments.filter(highlight => this.sameText(highlight.text, text));

        // 不知道这个 <mark> 在原文哪几行：只有全篇就这一个时才敢配，
        // 否则按文字挑第一个，标题里、正文里、表格里的同一个词就全配到同一条上了。
        if (!sectionInfo) {
            return sameText.length === 1 ? sameText[0] : null;
        }

        const inSection = sameText
            .filter(highlight =>
                highlight.line >= sectionInfo.lineStart &&
                highlight.line <= sectionInfo.lineEnd
            )
            .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
        if (inSection.length <= 1) return inSection[0] || null;

        // 同一段（同一张表）里这几个字划了不止一次：第几个 <mark> 就配第几个高亮。
        const sameSectionMarks = Array.from(rootElement.querySelectorAll('mark, span.highlight'))
            .filter(other => {
                if (!this.sameText(this.markText(other), text)) return false;
                const otherSection = this.getSectionInfo(other, rootElement, context);
                return otherSection?.lineStart === sectionInfo.lineStart;
            });
        const index = sameSectionMarks.indexOf(mark);
        return index >= 0 ? inSection[index] || null : null;
    }

    private getSectionInfo(
        mark: Element,
        rootElement: HTMLElement,
        context: MarkdownPostProcessorContext
    ): { lineStart: number; lineEnd: number } | null {
        // 往外找到第一个说得出自己在原文哪几行的块。最近的那个块（callout 里的 <p>）常常说不出。
        let block = mark.parentElement;
        while (block) {
            if (this.isBlockElement(block) || block === rootElement) {
                const info = context.getSectionInfo(block);
                if (info) return info;
            }
            if (block === rootElement) return null;
            block = block.parentElement;
        }
        return null;
    }

    private isBlockElement(element: Element): boolean {
        return BLOCK_TAGS.has(element.tagName.toLowerCase());
    }

    private getLineForPosition(content: string, position: number): number {
        return content.substring(0, position).split('\n').length - 1;
    }

}
