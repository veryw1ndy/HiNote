import { TFile, MarkdownPostProcessorContext } from "obsidian";
import { HighlightInfo as HiNote } from "../../../types/highlight";
import { HighlightRepository } from "../../../repositories/HighlightRepository";
import { HighlightService } from '../../../services/HighlightService';
import { CommentWidgetHelper, COMMENT_THREAD_CLASS, hasCommentThread } from '../../../components/comment';
import { PreviewHighlightResolver } from "./PreviewHighlightResolver";
import type { HiNotePluginContext } from "../../../types/plugin";

/** HiNote 自己渲染出来的地方：批注、悬停框、侧栏卡片的高亮文字、闪卡 */
const NOT_NOTE_TEXT = '.hi-note-content, .hi-note-tooltip-content, .highlight-text-content, .hi-note-tooltip, .flashcard-content-area';

/**
 * 阅读模式下的批注小部件渲染器
 * 负责在阅读模式（Preview Mode）中渲染批注图标和工具提示
 */
export class PreviewWidgetRenderer {
    private highlightResolver: PreviewHighlightResolver;

    /**
     * 每个见过的 <mark> 当时的渲染上下文。批注一变就靠它就地重画，
     * 不用整页重新渲染。WeakMap：页面重渲染后旧的 <mark> 自己会被回收。
     */
    private markContexts = new WeakMap<Element, { root: HTMLElement; context: MarkdownPostProcessorContext }>();

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
        // 批注、悬停框、侧栏卡片和闪卡里的文字也是按这篇笔记渲染的，里面的 ==…== 不是笔记的高亮，
        // 不能配到笔记的高亮上去（批注里写 ==abroad==，就会多出一个指向别处的批注图标）。
        const marks = Array.from(element.querySelectorAll('mark, span.highlight'))
            .filter(mark => !mark.closest(NOT_NOTE_TEXT) && !element.matches(NOT_NOTE_TEXT));
        if (marks.length === 0) return;

        marks.forEach(mark => this.markContexts.set(mark, { root: element, context }));
        await this.renderMarks(file, marks, false);
    }

    /**
     * 批注改了以后，就地重画这个文件已经渲染出来的高亮。
     *
     * post processor 只在渲染时跑一次，之后加的批注不会让它再跑：
     * 阅读模式要等下次重渲染才变色，实时预览里的表格单元格（也是 post processor 画的）
     * 要等表格被改动。这里把 containerEl 里属于该文件的 <mark> 重新匹配一遍。
     */
    async refresh(file: TFile, containerEl: HTMLElement): Promise<void> {
        const marks = Array.from(containerEl.querySelectorAll('mark, span.highlight'))
            .filter(mark => this.markContexts.get(mark)?.context.sourcePath === file.path);
        if (marks.length === 0) return;

        await this.renderMarks(file, marks, true);
    }

    /** 这个 <mark> 已经配过、批注按钮也还在 */
    isRendered(mark: Element): boolean {
        return this.markContexts.has(mark) && !!mark.querySelector(':scope > .hi-note-widget');
    }

    /**
     * 实时预览里表格（和别的块）是编辑器外面单独画的，post processor 碰不到里面的 <mark>：
     * 它们一直是黄的，也没有批注按钮。把它们交给阅读模式这套来配，
     * context 说明这个块覆盖原文的哪几行，同一句话出现几次时才配得对。
     */
    async adoptMarks(file: TFile, marks: Element[], root: HTMLElement, context: MarkdownPostProcessorContext): Promise<void> {
        marks.forEach(mark => this.markContexts.set(mark, { root, context }));
        await this.renderMarks(file, marks.filter(mark => mark.isConnected), true);
    }

    /**
     * reset 为 true 时先清掉旧的小部件再画。清理放在读完数据之后，
     * 免得重画的那一下批注图标闪一下没了。
     */
    private async renderMarks(file: TFile, marks: Element[], reset: boolean): Promise<void> {
        // 获取该文件的所有高亮数据
        const content = await this.plugin.app.vault.cachedRead(file);
        const rawHighlights = this.highlightService.extractHighlights(content, file);

        if (rawHighlights.length === 0) return;

        // 预处理高亮：获取评论并计算行号
        const highlightsWithComments = this.highlightResolver.enrichHighlightsWithComments(rawHighlights, file, content);

        if (highlightsWithComments.length === 0) return;

        // 遍历 DOM 元素进行匹配
        marks.forEach((mark) => {
            const rendered = this.markContexts.get(mark);
            if (!rendered) return;
            // post processor 跑的时候这段可能还没挂进批注里，读完文件以后再看一次
            if (mark.closest(NOT_NOTE_TEXT)) return;

            if (reset) {
                this.clearMark(mark);
            } else if (mark.hasAttribute('data-hi-note-processed')) {
                return;
            }

            const text = this.highlightResolver.markText(mark);
            if (!text) return;

            // 查找匹配的高亮
            const match = this.highlightResolver.findMatchingHighlight(
                text,
                mark,
                rendered.root,
                rendered.context,
                highlightsWithComments
            );

            if (match) {
                mark.setAttribute('data-hi-note-processed', 'true');
                this.renderPreviewWidget(mark as HTMLElement, match);
            }
        });
    }

    /** 拿掉之前画上去的东西。小部件一移除，createCleanupObserver 会顺手把悬停框也删掉。 */
    private clearMark(mark: Element): void {
        mark.removeAttribute('data-hi-note-processed');
        mark.removeClass(COMMENT_THREAD_CLASS);
        Array.from(mark.children)
            .filter(child => child.hasClass('hi-note-preview-widget'))
            .forEach(widget => widget.remove());
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
