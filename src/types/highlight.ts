export interface CommentItem {
    id: string;
    content: string;
    createdAt: number;
    updatedAt: number;
}

/**
 * 图里的一处高亮：哪张图，从第几个 <text> 的第几个字到第几个 <text> 的第几个字（不含）。
 * 下标按图里 <text> 出现的顺序数，和图怎么排版无关。
 */
export interface FigureAnchor {
    path: string;
    from: [textIndex: number, charIndex: number];
    to: [textIndex: number, charIndex: number];
}

export interface HighlightInfo {
    id?: string;
    text: string;
    position: number;
    createdAt?: number;
    updatedAt?: number;
    comments?: CommentItem[];

    paragraphOffset?: number;
    blockId?: string;
    contextBefore?: string;
    contextAfter?: string;
    textFingerprint?: string;

    filePath?: string;
    fileName?: string;
    fileIcon?: string;

    backgroundColor?: string;
    originalLength?: number;

    isVirtual?: boolean;
    /** 有这个字段的是图里的高亮：笔记正文里没有它的 ==…==，不要拿去和正文匹配。 */
    figure?: FigureAnchor;
    isCloze?: boolean;
    isGlobalSearch?: boolean;
    isFromCanvas?: boolean;
    canvasSource?: string;
}

export interface RegexRule {
    id: string;
    name: string;
    pattern: string;
    color: string;
    enabled: boolean;
}

export interface HighlightSettings {
    export: {
        exportPath: string;
        exportTemplate?: string;
    };
    excludePatterns: string;
    useCustomPattern: boolean;
    regexRules: RegexRule[];
}
