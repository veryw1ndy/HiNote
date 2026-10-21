import type { HighlightInfo as HiNote } from '../types/highlight';

/** 代码块里的一行：内容从原文第几个字开始，是代码里第几个字，多长 */
export interface CodeLine {
    src: number;
    code: number;
    len: number;
}

/** 笔记原文里的一个 ``` 代码块 */
export interface CodeBlock {
    /** ``` 那行是原文第几行（从 0 数） */
    line: number;
    lang: string;
    /** 代码本身：去掉了 ``` 两行、引用的 > 和围栏前的缩进，和页面上显示的一样 */
    code: string;
    /** 代码的指纹，高亮靠它认代码块 */
    sig: string;
    lines: CodeLine[];
}

/** 一处高亮落在第几个代码块，代码里第几个字到第几个字（不含） */
export interface CodeSpot {
    block: number;
    from: number;
    to: number;
}

const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const QUOTE = /^(?: {0,3}>[ \t]?)*/;

function quoteDepth(prefix: string): number {
    return (prefix.match(/>/g) || []).length;
}

function hash(s: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * 笔记原文里的代码块，和代码块里的一处高亮现在落在哪儿。
 *
 * 代码块里的高亮存的是代码块的指纹和代码里第几个字到第几个字（figure.kind 是 'code'）。
 * 代码块改过、指纹对不上时，就在同一种语言的代码块里找高亮的那几个字，取离原来位置最近的一处。
 */
export class CodeSource {
    static blocks(src: string): CodeBlock[] {
        const out: CodeBlock[] = [];
        const rows = src.split('\n');
        let offset = 0;
        let open: {
            line: number; lang: string; char: string; size: number; indent: number; depth: number;
            lines: CodeLine[]; parts: string[]; code: number;
        } | null = null;

        const close = () => {
            if (!open) return;
            const code = open.parts.join('\n');
            out.push({ line: open.line, lang: open.lang, code, sig: `code:${hash(code)}`, lines: open.lines });
            open = null;
        };

        for (let i = 0; i < rows.length; i++) {
            const raw = rows[i].replace(/\r$/, '');
            const start = offset;
            offset += rows[i].length + 1;
            const prefix = QUOTE.exec(raw)![0];
            const body = raw.slice(prefix.length);

            if (open) {
                // 引用里的代码块，引用断了它也就完了
                if (quoteDepth(prefix) < open.depth) {
                    close();
                } else {
                    const fence = FENCE.exec(body);
                    if (fence && fence[2][0] === open.char && fence[2].length >= open.size && fence[3].trim() === '') {
                        close();
                        continue;
                    }
                    let cut = 0;
                    while (cut < open.indent && body[cut] === ' ') cut++;
                    const text = body.slice(cut);
                    open.lines.push({ src: start + prefix.length + cut, code: open.code, len: text.length });
                    open.parts.push(text);
                    open.code += text.length + 1;
                    continue;
                }
            }

            const fence = FENCE.exec(body);
            if (!fence) continue;
            const info = fence[3];
            if (fence[2][0] === '`' && info.includes('`')) continue;
            open = {
                line: i, lang: info.trim().split(/\s+/)[0] || '', char: fence[2][0], size: fence[2].length,
                indent: fence[1].length, depth: quoteDepth(prefix), lines: [], parts: [], code: 0
            };
        }
        close();
        return out;
    }

    /** 代码里第几个字 → 原文第几个字 */
    static toSrc(block: CodeBlock, at: number): number {
        for (const line of block.lines) {
            if (at <= line.code + line.len) return line.src + Math.max(0, at - line.code);
        }
        const last = block.lines[block.lines.length - 1];
        return last ? last.src + last.len : 0;
    }

    /** 原文第几个字 → 代码里第几个字；不在这个代码块的代码里就是 null */
    static toCode(block: CodeBlock, at: number): number | null {
        for (const line of block.lines) {
            if (at >= line.src && at <= line.src + line.len) return line.code + at - line.src;
        }
        return null;
    }

    /** 原文这一处在哪个代码块的代码里 */
    static at(blocks: CodeBlock[], at: number): { block: number; code: number } | null {
        for (let i = 0; i < blocks.length; i++) {
            const code = CodeSource.toCode(blocks[i], at);
            if (code != null) return { block: i, code };
        }
        return null;
    }

    static resolve(blocks: CodeBlock[], h: HiNote | null | undefined): CodeSpot | null {
        const anchor = h?.figure;
        if (!h || anchor?.kind !== 'code') return null;
        const text = h.text || '';
        let best: CodeSpot | null = null;
        let bestDistance = Infinity;
        const consider = (block: number, from: number) => {
            const distance = Math.abs(CodeSource.toSrc(blocks[block], from) - h.position);
            if (distance < bestDistance) {
                best = { block, from, to: from + text.length };
                bestDistance = distance;
            }
        };

        // 代码块没改过：指纹一样，那几个字也还在原处
        const [from] = anchor.from;
        blocks.forEach((b, i) => {
            if (b.sig === anchor.path && b.code.slice(from, anchor.to[0]) === text) consider(i, from);
        });
        if (best || !text) return best;

        // 改过了：在同一种语言的代码块里找那几个字
        blocks.forEach((b, i) => {
            if (b.lang !== anchor.label) return;
            for (let at = b.code.indexOf(text); at !== -1; at = b.code.indexOf(text, at + 1)) consider(i, at);
        });
        return best;
    }
}
