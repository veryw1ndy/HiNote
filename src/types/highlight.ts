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
    kind?: undefined;
    path: string;
    from: [textIndex: number, charIndex: number];
    to: [textIndex: number, charIndex: number];
}

/**
 * 公式里的一处高亮：哪个公式（path 是公式的指纹，见 src/math/mathDom.ts），
 * 划中了它的第几个字形（leaves，按公式里字形出现的顺序数）。
 * tex 是公式在笔记里的原文；line / lineNth 记它在哪一行、是那一行里第几个同样的公式，
 * 一篇笔记里同一个公式出现好几次时靠这个分清（见 src/math/mathSource.ts）。
 */
export interface MathAnchor {
    kind: 'math';
    path: string;
    label: string;
    tex: string;
    leaves: number[];
    from: [leafIndex: number];
    to: [leafIndex: number];
    line?: string;
    lineNth?: number;
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
    /** 有这个字段的是图里（或公式里）的高亮：笔记正文里没有它的 ==…==，不要拿去和正文匹配。 */
    figure?: FigureAnchor | MathAnchor;
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
