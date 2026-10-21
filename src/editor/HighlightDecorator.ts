import { Plugin, MarkdownView } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { HighlightRepository } from "../repositories/HighlightRepository";
import { HighlightService } from '../services/HighlightService';
import { PreviewWidgetRenderer } from '../views/highlight';
import { createEditorHighlightDecorations } from "./EditorHighlightDecorations";
import type { HighlightEvents } from "../services/EventManager";
import type { EventManager } from "../services/EventManager";
import type { HiNotePluginContext } from "../types/plugin";

interface EditorWithCodeMirror {
    cm?: EditorView;
}

export class HighlightDecorator {
    private plugin: HiNotePluginContext;
    private highlightRepository: HighlightRepository;
    private highlightPlugin: ReturnType<typeof createEditorHighlightDecorations> | null = null;
    private highlightService: HighlightService;
    readonly previewRenderer: PreviewWidgetRenderer;

    constructor(
        plugin: Plugin,
        highlightRepository: HighlightRepository,
        highlightService: HighlightService,
        private eventManager: EventManager
    ) {
        this.plugin = plugin as HiNotePluginContext;
        this.highlightRepository = highlightRepository;
        this.highlightService = highlightService;
        this.previewRenderer = new PreviewWidgetRenderer(
            this.plugin,
            this.highlightRepository,
            this.highlightService
        );
    }

    /**
     * 强制刷新装饰器
     * 当评论数据发生变化时调用此方法来更新 CommentWidget 的显示和有批注高亮的颜色
     *
     * 刷新所有打开着该文件的窗格，而不是「当前聚焦的」那个：在侧栏里写批注时
     * 聚焦的是侧栏，getActiveViewOfType(MarkdownView) 拿到 null，以前就什么都不刷，
     * 要点回笔记里才变色。不传 filePath 就全部刷新。
     */
    public refreshDecorations(filePath?: string) {
        this.plugin.app.workspace.getLeavesOfType('markdown').forEach(leaf => {
            const view = leaf.view;
            if (!(view instanceof MarkdownView) || !view.file) return;
            if (filePath && view.file.path !== filePath) return;

            // 实时预览：空事务让 ViewPlugin 重新构建装饰器
            (view.editor as unknown as EditorWithCodeMirror).cm?.dispatch({});

            // 阅读模式，以及实时预览里的表格单元格：这些 <mark> 是 post processor 画的
            void this.previewRenderer.refresh(view.file, view.containerEl);
        });
    }


    

    private getActiveMarkdownView() {
        return this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    }

    enable() {
        this.plugin.registerMarkdownPostProcessor((element, context) => {
            void this.previewRenderer.processPreview(element, context);
        });

        this.registerRefreshEvents();

        const highlightPlugin = createEditorHighlightDecorations({
            plugin: this.plugin,
            highlightService: this.highlightService,
            highlightRepository: this.highlightRepository
        });

        this.highlightPlugin = highlightPlugin;
        this.plugin.registerEditorExtension([highlightPlugin]);
    }

    private registerRefreshEvents(): void {
        const refreshEvents: (keyof HighlightEvents)[] = [
            'comment:update',
            'comment:delete',
            'highlight:update',
            'highlight:delete'
        ];

        refreshEvents.forEach(eventName => {
            this.plugin.registerEvent(
                this.eventManager.on(eventName, (filePath: string, oldText: string, newText: string) => {
                    // 文字变了的 highlight:update 是编辑器重建装饰器时自己发的
                    // （EditorHighlightDecorations 里的 emitHighlightTextChange）。那时还在
                    // CM6 的 update 里，再 dispatch 会抛错，CM6 就把整个装饰插件关掉，
                    // 这个笔记里的批注图标和颜色一起消失。文档改动本身已经触发了重建，不用再刷。
                    if (eventName === 'highlight:update' && oldText !== newText) return;

                    this.refreshDecorations(filePath);
                })
            );
        });
    }

    disable() {
        // 移除编辑器扩展
        if (this.highlightPlugin) {
            const view = this.getActiveMarkdownView();
            if (view?.editor) {
                // 刷新编辑器以移除所有装饰器
                view.editor.refresh();
            }
        }

        // 移除所有高亮评论按钮
        activeDocument.querySelectorAll('.hi-note-widget').forEach(el => el.remove());
    }
}
