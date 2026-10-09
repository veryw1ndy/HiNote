import { TFile, MarkdownPostProcessorContext } from "obsidian";
import { HighlightInfo as HiNote } from "../../../types/highlight";
import { HighlightRepository } from "../../../repositories/HighlightRepository";
import { HighlightService } from '../../../services/HighlightService';
import { CommentWidgetHelper, COMMENT_THREAD_CLASS, hasCommentThread } from '../../../components/comment';
import { PreviewHighlightResolver } from "./PreviewHighlightResolver";
import type { HiNotePluginContext } from "../../../types/plugin";

/**
 * 阅读模式下的批注小部件渲染器
 * 负责在阅读模式（Preview Mode）中渲染批注图标和工具提示
 */
export class PreviewWidgetRenderer {
    private highlightResolver: PreviewHighlightResolver;

    constructor(
        private plugin: HiNotePluginContext,
        private highlightRepository: HighlightRepository,
        private highlightService: HighlightService
    ) {
        this.highlightResolver = new PreviewHighlightResolver(this.highlightRepository);
    }

    /**
     * 处理阅读模式下的高亮渲染
     * 在 Markdown Post Processor 中调用
     */
    async processPreview(element: HTMLElement, context: MarkdownPostProcessorContext): Promise<void> {
        const file = this.plugin.app.vault.getAbstractFileByPath(context.sourcePath);
        if (!(file instanceof TFile)) return;

        // 检查是否应该处理该文件
        if (!this.highlightService.shouldProcessFile(file)) return;

        // 查找高亮元素
        const marks = element.querySelectorAll('mark, span.highlight');
        if (marks.length === 0) return;

        // 获取该文件的所有高亮数据
        const content = await this.plugin.app.vault.cachedRead(file);
        const rawHighlights = this.highlightService.extractHighlights(content, file);

        if (rawHighlights.length === 0) return;

        // 预处理高亮：获取评论并计算行号
        const highlightsWithComments = this.highlightResolver.enrichHighlightsWithComments(rawHighlights, file, content);

        if (highlightsWithComments.length === 0) return;

        // 遍历 DOM 元素进行匹配
        marks.forEach((mark) => {
            if (mark.hasAttribute('data-hi-note-processed')) return;
            
            const text = mark.textContent;
            if (!text) return;

            // 查找匹配的高亮
            const match = this.highlightResolver.findMatchingHighlight(
                text, 
                mark, 
                element, 
                context, 
                highlightsWithComments
            );

            if (match) {
                mark.setAttribute('data-hi-note-processed', 'true');
                this.renderPreviewWidget(mark as HTMLElement, match);
            }
        });
    }

    /**
     * 渲染阅读模式下的批注小部件
     */
    private renderPreviewWidget(mark: HTMLElement, highlight: HiNote): void {
        // 阅读模式下直接拿得到 <mark>，加个 class 就换色了。
        mark.toggleClass(COMMENT_THREAD_CLASS, hasCommentThread(highlight));

        const widget = mark.createSpan({ cls: 'hi-note-widget hi-note-preview-widget' });
        const hasComments = !!(highlight.comments && highlight.comments.length > 0);
        
        // 使用辅助类创建按钮
        const button = CommentWidgetHelper.createButton(widget, hasComments);
        const iconContainer = button.querySelector('.hi-note-icon-container') as HTMLElement;
        
        const openPanel = () =>
            CommentWidgetHelper.openCommentPanel(
                this.plugin.app, highlight, this.plugin.eventManager
            );

        if (hasComments && highlight.comments) {
            // 添加评论数量
            CommentWidgetHelper.addCommentCount(iconContainer, highlight.comments.length);

            // 创建工具提示
            const tooltip = CommentWidgetHelper.createTooltip(this.plugin.app, highlight);
            
            // 设置工具提示事件
            CommentWidgetHelper.setupTooltipEvents(button, widget, tooltip);
            
            // 设置点击事件
            CommentWidgetHelper.setupClickEvent(button, tooltip, openPanel);
            
            // 创建清理观察器
            CommentWidgetHelper.createCleanupObserver(widget, tooltip);
        } else {
            // 阅读模式下，没有评论的高亮也要能加批注：
            // 悬停时显示图标，点击打开批注面板。
            CommentWidgetHelper.setupEmptyCommentHover(widget, button);
            button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                void openPanel();
            });
        }
    }
}
