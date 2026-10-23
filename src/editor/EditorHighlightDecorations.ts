import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import type { Range } from "@codemirror/state";
import { editorInfoField, TFile } from "obsidian";
import { CommentWidget, CommentWidgetHelper, COMMENT_THREAD_CLASS, hasCommentThread } from "../components/comment";
import { HighlightRepository } from "../repositories/HighlightRepository";
import { HighlightService } from "../services/HighlightService";
import { HighlightCommentResolver } from "../services/highlight";
import { HighlightInfo as HiNote } from "../types/highlight";
import type { HiNotePluginContext } from "../types/plugin";

interface EditorHighlightDecorationOptions {
    plugin: HiNotePluginContext;
    highlightService: HighlightService;
    highlightRepository: HighlightRepository;
}

export function createEditorHighlightDecorations(options: EditorHighlightDecorationOptions) {
    const { plugin, highlightService, highlightRepository } = options;
    const highlightCommentResolver = new HighlightCommentResolver(highlightRepository);

    return ViewPlugin.fromClass(class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
            this.decorations = this.buildDecorations(view);
        }

        update(update: ViewUpdate): void {
            if (update.docChanged || update.viewportChanged || update.transactions.length > 0) {
                this.decorations = this.buildDecorations(update.view);
            }
        }

        private buildDecorations(view: EditorView): DecorationSet {
            // 用这个编辑器自己的文件，而不是「当前聚焦的窗格」：焦点在侧栏时后者是 null，
            // 一滚动笔记就把所有批注图标和颜色清空；分屏时还会拿错文件。
            const file = view.state.field(editorInfoField, false)?.file;

            if (!file || !highlightService.shouldProcessFile(file)) {
                return Decoration.none;
            }

            const decorations: Range<Decoration>[] = [];
            const highlights = highlightService.extractHighlights(view.state.doc.toString(), file);

            // 整篇一起配，拿到存下来的记录的 ID。以前这里只配批注、ID 还是临时算的，
            // 点图标时侧栏按 ID 找不到卡片，就按文字随便挑了一张同名的（图里的、标题里的）。
            for (const { highlight, stored } of highlightCommentResolver.resolveAll(file, highlights)) {
                if (highlight.position === undefined) continue;

                if (stored && stored.text !== highlight.text) {
                    emitHighlightTextChange(plugin, file, stored, highlight);
                }

                const docLength = view.state.doc.length;
                const highlightEndPos = Math.min(
                    highlight.position + (highlight.originalLength ?? highlight.text.length + 4),
                    docLength
                );

                // 有批注的高亮换个颜色。标记必须有长度，零长度 CM6 会报错。
                if (hasCommentThread(highlight) && highlightEndPos > highlight.position) {
                    decorations.push(
                        Decoration.mark({ class: COMMENT_THREAD_CLASS })
                            .range(highlight.position, highlightEndPos)
                    );
                }

                if (shouldShowCommentWidget(plugin)) {
                    decorations.push(createCommentWidget(plugin, highlight).range(highlightEndPos));
                }
            }

            // 让 CM6 自己排：同一个位置上标记和小部件的先后它比我们清楚。
            return Decoration.set(decorations, true);
        }
    }, {
        decorations: value => value.decorations
    });
}

function createCommentWidget(plugin: HiNotePluginContext, highlight: HiNote): Decoration {
    return Decoration.widget({
        widget: new CommentWidget(
            plugin,
            highlight,
            () => {
                void CommentWidgetHelper.openCommentPanel(plugin.app, highlight, plugin.eventManager);
            }
        ),
        side: 2,
        stopEvent: (event: Event) => event.type === 'mousedown' || event.type === 'mouseup'
    });
}

function shouldShowCommentWidget(plugin: HiNotePluginContext): boolean {
    return plugin.settings.showCommentWidget !== false;
}

function emitHighlightTextChange(
    plugin: HiNotePluginContext,
    file: TFile,
    storedHighlight: HiNote,
    currentHighlight: HiNote
): void {
    if (storedHighlight.text === currentHighlight.text) return;

    plugin.eventManager.emitHighlightUpdate(
        file.path,
        storedHighlight.text,
        currentHighlight.text,
        currentHighlight.id ?? storedHighlight.id ?? ''
    );
}
