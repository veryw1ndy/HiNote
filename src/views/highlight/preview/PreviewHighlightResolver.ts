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
        return rawHighlights
            .map(highlight => this.enrichHighlight(highlight, file))
            .map(highlight => ({
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
        return this.plainText(highlightText) === this.plainText(domText);
    }

    findMatchingHighlight(
        text: string,
        mark: Element,
        rootElement: HTMLElement,
        context: MarkdownPostProcessorContext,
        highlightsWithComments: PreviewHighlight[]
    ): PreviewHighlight | null {
        const sectionInfo = this.getSectionInfo(mark, rootElement, context);

        if (!sectionInfo) {
            return highlightsWithComments.find(highlight => this.sameText(highlight.text, text)) || null;
        }

        return highlightsWithComments.find(highlight =>
            this.sameText(highlight.text, text) &&
            highlight.line >= sectionInfo.lineStart &&
            highlight.line <= sectionInfo.lineEnd
        ) || null;
    }

    private enrichHighlight(highlight: HiNote, file: TFile): HiNote {
        return this.commentResolver.resolveHighlight(file, highlight);
    }

    private getSectionInfo(
        mark: Element,
        rootElement: HTMLElement,
        context: MarkdownPostProcessorContext
    ): { lineStart: number; lineEnd: number } | null {
        let block = mark.parentElement;

        while (block && !this.isBlockElement(block) && block !== rootElement) {
            block = block.parentElement;
        }

        return block ? context.getSectionInfo(block) : null;
    }

    private isBlockElement(element: Element): boolean {
        return BLOCK_TAGS.has(element.tagName.toLowerCase());
    }

    private getLineForPosition(content: string, position: number): number {
        return content.substring(0, position).split('\n').length - 1;
    }

}
