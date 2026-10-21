import { App, MarkdownView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { HighlightInfo } from "../types/highlight";
import { FIGURE_FLASH_EVENT } from "../figure/FigureHighlighter";
import { MathSource } from "../math/mathSource";

export class LocationService {
    constructor(private app: App) {}

    /**
     * 跳转到指定的高亮位置
     */
    public async jumpToHighlight(highlight: HighlightInfo, currentFilePath: string) {
        // 1. 打开或激活文件
        const targetLeaf = await this.openOrActivateFile(currentFilePath);
        if (!targetLeaf) return;

        // 2. 定位高亮内容，传递 position 参数
        if (highlight.figure) {
            await this.locateFigure(targetLeaf, highlight);
            return;
        }
        await this.locateAndHighlightText(targetLeaf, highlight.text, highlight.position);
    }

    /**
     * 图里的高亮：正文里没有它的文字，滚到嵌入这张图的那一行，再让图里那一处闪一下。
     * 不选中文字 —— 实时预览里一选中嵌入链接，图就变回源码了。
     */
    private async locateFigure(leaf: WorkspaceLeaf, highlight: HighlightInfo) {
        await new Promise(resolve => window.setTimeout(resolve, 300));

        const markdownView = leaf.view as MarkdownView;
        const editor = markdownView.editor;
        const content = editor.getValue();
        const figure = highlight.figure!;
        // 公式：按它的 LaTeX 找；同一公式有好几份时找高亮做在的那一份；
        // 没记 LaTeX 的旧高亮，就用存下的位置
        let name = figure.kind === 'math' ? figure.tex || '' : figure.path.split('/').pop() || '';

        let best = -1;
        if (figure.kind === 'math') {
            if (!name && highlight.position > 0) best = Math.min(highlight.position, content.length);
            const resolved = name ? MathSource.resolve(content, highlight) : null;
            if (resolved != null) {
                best = resolved;
                name = '';
            }
        }
        for (let at = name ? content.indexOf(name) : -1; at !== -1; at = content.indexOf(name, at + 1)) {
            if (best === -1 || Math.abs(at - highlight.position) < Math.abs(best - highlight.position)) {
                best = at;
            }
        }

        if (best !== -1) {
            const pos = editor.offsetToPos(best);
            if (markdownView.getMode() === 'preview') {
                leaf.setEphemeralState({ line: pos.line, scroll: pos.line });
            } else {
                editor.scrollIntoView({ from: pos, to: pos }, true);
            }
        }

        // 等图滚进来、渲染好再闪
        window.setTimeout(() => {
            markdownView.containerEl.dispatchEvent(
                new CustomEvent(FIGURE_FLASH_EVENT, { detail: highlight.id })
            );
        }, 400);
    }

    /**
     * 打开或激活指定文件，但不聚焦
     */
    private async openOrActivateFile(filePath: string): Promise<WorkspaceLeaf | null> {
        // 先查找已打开的文件
        const markdownLeaves = this.app.workspace.getLeavesOfType("markdown");
        let targetLeaf = markdownLeaves.find((leaf: WorkspaceLeaf) => {
            const view = leaf.view as MarkdownView;
            return view.file?.path === filePath;
        });
        
        // 如果文件未打开，则打开它
        if (!targetLeaf) {
            try {
                const file = this.app.vault.getAbstractFileByPath(filePath);
                if (!(file instanceof TFile)) {
                    new Notice("未找到文件");
                    return null;
                }
                
                targetLeaf = this.app.workspace.getLeaf('tab');
                await targetLeaf.openFile(file);
            } catch {
                new Notice("打开文件失败");
                return null;
            }
        }
        
        // 激活编辑器视图，但不聚焦
        this.app.workspace.setActiveLeaf(targetLeaf, { focus: false });
        return targetLeaf;
    }

    /**
     * 在编辑器中定位并高亮文本
     */
    private async locateAndHighlightText(leaf: WorkspaceLeaf, text: string, position?: number) {
        // 确保编辑器已准备就绪
        await new Promise(resolve => window.setTimeout(resolve, 300));
        
        const markdownView = leaf.view as MarkdownView;
        const editor = markdownView.editor;
        const content = editor.getValue();
        
        let textPosition = -1;
        let allMatches: number[] = [];
        let matchedText = text; // 默认使用原始文本
        
        // 找出所有精确匹配项
        let searchPos = 0;
        let foundPos = -1;
        while ((foundPos = content.indexOf(text, searchPos)) !== -1) {
            allMatches.push(foundPos);
            searchPos = foundPos + 1;
        }
        
        // 如果提供了 position，则优先使用它
        if (position !== undefined && position >= 0) {
            // 首先检查精确匹配
            if (content.substring(position, position + text.length) === text) {
                textPosition = position;
            } else {
                // 如果没有精确匹配，则找最接近的匹配项
                if (allMatches.length > 0) {
                    // 找到与指定位置最接近的匹配项
                    let closestMatch = allMatches[0];
                    let minDistance = Math.abs(position - closestMatch);
                    
                    for (const match of allMatches) {
                        const distance = Math.abs(position - match);
                        if (distance < minDistance) {
                            minDistance = distance;
                            closestMatch = match;
                        }
                    }
                    
                    textPosition = closestMatch;
                }
            }
        }
        
        // 如果没有找到精确匹配项
        if (textPosition === -1) {
            if (allMatches.length > 0) {
                textPosition = allMatches[0];
            } else {
                new Notice("未找到高亮内容");
                return;
            }
        }
        
        // 将文本位置转换为编辑器位置
        const start = editor.offsetToPos(textPosition);
        const end = editor.offsetToPos(textPosition + matchedText.length);
        
        // 检查视图模式
        const mode = markdownView.getMode(); // 'source' | 'preview'

        if (mode === 'preview') {
            // 阅读模式下的处理
            // 使用 setEphemeralState 滚动到指定行
            // startLoc 和 endLoc 用于传递位置信息
            leaf.setEphemeralState({
                line: start.line,
                startLoc: { line: start.line, col: start.ch },
                endLoc: { line: end.line, col: end.ch },
                scroll: start.line
            });
        } else {
            // 编辑/实时预览模式下的处理
            // 1. 选中文本
            editor.setSelection(start, end);
            
            // 2. 滚动到目标位置，并确保选中内容在编辑器中间位置显示
            editor.scrollIntoView({from: start, to: end}, true);
            
            // 3. 聚焦编辑器，确保用户可以看到选中内容
            this.app.workspace.setActiveLeaf(leaf, { focus: true });
        }
    }

} 
