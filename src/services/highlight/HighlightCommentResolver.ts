import { TFile } from "obsidian";
import { HighlightInfo as HiNote, CommentItem } from "../../types/highlight";
import { HighlightRepository } from "../../repositories/HighlightRepository";
import { findStoredHighlightMatch, pairStoredHighlights } from "./HighlightMatchStrategies";

interface CommentResolverOptions {
    onTextChanged?: (storedHighlight: HiNote, currentHighlight: HiNote) => void;
}

/**
 * 将当前文档中提取到的高亮，与仓库里保存的评论数据进行匹配。
 */
export class HighlightCommentResolver {
    constructor(private highlightRepository: HighlightRepository) {}

    normalizeHighlight(highlight: HiNote): HiNote {
        return {
            ...highlight,
            comments: highlight.comments || [],
            position: highlight.position,
            paragraphOffset: highlight.paragraphOffset || 0,
            blockId: highlight.blockId,
            createdAt: highlight.createdAt || Date.now(),
            updatedAt: highlight.updatedAt || Date.now(),
            text: highlight.text
        };
    }

    resolveHighlight(file: TFile, highlight: HiNote): HiNote {
        const normalizedHighlight = this.normalizeHighlight(highlight);
        const storedHighlight = this.findStoredHighlight(file, normalizedHighlight);

        return {
            ...normalizedHighlight,
            id: storedHighlight?.id || normalizedHighlight.id,
            comments: storedHighlight?.comments || []
        };
    }

    /**
     * 一个笔记里的全部高亮一起配上存下来的记录：拿记录的 ID 和批注。
     * 编辑模式和阅读模式都用这个，和侧栏（HighlightMatcher）是同一个配对，
     * 点批注图标时带过去的 ID 才是侧栏卡片的 ID。
     */
    resolveAll(file: TFile, highlights: HiNote[]): { highlight: HiNote; stored: HiNote | null }[] {
        const fileHighlights = this.highlightRepository.getCachedHighlights(file.path) || [];
        const pairs = pairStoredHighlights(highlights, fileHighlights);

        return highlights.map((highlight, i) => {
            const normalized = this.normalizeHighlight(highlight);
            const stored = pairs[i].match?.highlight || null;
            return {
                highlight: {
                    ...normalized,
                    id: stored?.id || normalized.id,
                    comments: stored?.comments || []
                },
                stored
            };
        });
    }

    getCommentsForHighlight(
        file: TFile,
        highlight: HiNote,
        options: CommentResolverOptions = {}
    ): CommentItem[] {
        const storedHighlight = this.findStoredHighlight(file, highlight);

        if (!storedHighlight) {
            return [];
        }

        if (storedHighlight.text !== highlight.text) {
            options.onTextChanged?.(storedHighlight, highlight);
        }

        return storedHighlight.comments || [];
    }

    private findStoredHighlight(file: TFile, highlight: HiNote): HiNote | null {
        if (highlight.blockId) {
            const blockHighlights = this.highlightRepository.findHighlightsByBlockId(file, highlight.blockId);
            const blockMatch = findStoredHighlightMatch(highlight, blockHighlights);
            if (blockMatch) return blockMatch.highlight;
        }

        const fileHighlights = this.highlightRepository.getCachedHighlights(file.path) || [];
        return findStoredHighlightMatch(highlight, fileHighlights)?.highlight || null;
    }
}
