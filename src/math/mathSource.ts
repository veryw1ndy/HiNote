import type { HighlightInfo as HiNote } from '../types/highlight';

/** 笔记里的一个公式：从哪儿开始、原文、它所在那一行、是那一行里第几个同样的公式 */
export interface MathOccurrence {
    position: number;
    tex: string;
    line: string;
    lineNth: number;
}

/**
 * 页面上的一个公式在原文里的范围，见 place()：
 *   from / to            它所在的块覆盖的原文范围；
 *   table / row / col    （可选）块里第几张表、第几行、第几格；
 *   nth / nthInCell      它是块里（格子里）第几个同样的公式。
 */
export interface MathSpot {
    from: number;
    to: number;
    nth: number;
    table?: number;
    row?: number;
    col?: number;
    nthInCell?: number;
}

const CODE = /```[\s\S]*?```|`[^`\n]*`/g;
const FORMULA = /\$\$[\s\S]*?\$\$|\$[^$\n]+?\$/g;

/** 代码里的 $ 不是公式：换成等长的空格，位置不变 */
function maskCode(src: string): string {
    return src.replace(CODE, s => ' '.repeat(s.length));
}

/**
 * 一个高亮在同一公式的哪一份上。
 *
 * 一篇笔记里同一个公式可以出现很多次（∀α. α → α 在四张表里），它们的指纹都一样。
 * 所以高亮还记着公式所在的那一行原文（line）和它是那一行里第几个同样的公式（lineNth）。
 * 页面上每个公式按它在页面上的位置（块、表、行、格）算出自己在原文里的位置，
 * 高亮只画在它对得上的那一份上。这里都是只看笔记原文的纯函数。
 */
export class MathSource {
    /** 去掉两头的 $ 和所有空白，用来比较两个公式是不是同一个 */
    static strip(s: string | null | undefined): string {
        return (s || '').replace(/^\$\$?|\$\$?$/g, '').replace(/\s+/g, '');
    }

    /** 这个公式在笔记里的每一份 */
    static occurrences(src: string, latex: string): MathOccurrence[] {
        const want = this.strip(latex);
        if (!want) return [];
        const out: MathOccurrence[] = [];
        let lineAt = -1;
        let n = 0;
        for (const m of maskCode(src).matchAll(FORMULA)) {
            if (this.strip(m[0]) !== want) continue;
            const index = m.index ?? 0;
            const a = src.lastIndexOf('\n', index - 1) + 1;
            const b = src.indexOf('\n', index);
            if (a !== lineAt) {
                lineAt = a;
                n = 0;
            }
            out.push({
                position: index,
                tex: src.slice(index, index + m[0].length),
                line: src.slice(a, b < 0 ? src.length : b).trim(),
                lineNth: n++
            });
        }
        return out;
    }

    static words(s: string | null | undefined): Set<string> {
        return new Set((s || '').toLowerCase().split(/[^a-z0-9\\]+/).filter(Boolean));
    }

    /** 存下来的高亮在哪一份公式上；说不准时返回 null */
    static resolve(src: string, h: HiNote | null | undefined): number | null {
        const f = h?.figure;
        if (!h || f?.kind !== 'math' || !f.tex) return null;
        const occ = this.occurrences(src, f.tex);
        if (!occ.length) return null;
        const near = (list: MathOccurrence[]) => list.reduce((a, o) =>
            Math.abs(o.position - h.position) < Math.abs(a.position - h.position) ? o : a);
        if (f.line != null) {
            const line = f.line.trim();
            const same = occ.filter(o => o.line === line);
            if (same.length) return (same.find(o => o.lineNth === f.lineNth) || near(same)).position;
            // 那一行改过了：找和它共用的词最多的一行，一样多的取最近的
            const w = this.words(f.line);
            const score = (o: MathOccurrence) => {
                const v = this.words(o.line);
                let k = 0;
                v.forEach(x => { if (w.has(x)) k++; });
                return k / (v.size + w.size - k || 1);
            };
            const best = Math.max(...occ.map(score));
            return near(occ.filter(o => score(o) === best)).position;
        }
        return near(occ).position;
    }

    /** 原文里一行表格的各个格子，[from, to) */
    static cells(src: string, from: number, to: number): [number, number][] {
        let i = from;
        while (i < to && /[>\s]/.test(src[i])) i++;
        if (src[i] === '|') i++;
        const out: [number, number][] = [];
        let start = i;
        let inMath = false;
        for (; i < to; i++) {
            const ch = src[i];
            if (ch === '\\') {
                i++;
                continue;
            }
            if (ch === '$') inMath = !inMath;
            else if (ch === '|' && !inMath) {
                out.push([start, i]);
                start = i + 1;
            }
        }
        if (src.slice(start, to).trim()) out.push([start, to]);
        return out;
    }

    /** 页面上的一个公式在原文里的位置（见 MathSpot）；找不到时返回 null */
    static place(src: string, latex: string, at: MathSpot): number | null {
        const inside = (a: number, b: number) =>
            this.occurrences(src, latex).filter(o => o.position >= a && o.position < b);
        if (at.table != null && at.row != null && at.col != null) {
            const lines: [number, number][] = [];
            for (let a = at.from; a <= at.to;) {
                let b = src.indexOf('\n', a);
                if (b < 0 || b > at.to) b = at.to;
                lines.push([a, b]);
                a = b + 1;
            }
            // 连着的以 | 开头的行是一张表
            const tables: [number, number][][] = [];
            let rows: [number, number][] | null = null;
            lines.forEach(([a, b]) => {
                const t = src.slice(a, b).replace(/^[>\s]*/, '');
                if (t.startsWith('|')) {
                    if (!rows) tables.push((rows = []));
                    rows.push([a, b]);
                } else {
                    rows = null;
                }
            });
            const table = tables[at.table];
            // 表头是第 0 行；原文里第 1 行是 | --- |，页面上没有
            const line = table && table[at.row === 0 ? 0 : at.row + 1];
            const cell = line && this.cells(src, line[0], line[1])[at.col];
            if (cell) {
                const hit = inside(cell[0], cell[1]);
                const nth = at.nthInCell ?? 0;
                if (hit[nth]) return hit[nth].position;
            }
        }
        const hit = inside(at.from, at.to + 1);
        return hit[at.nth] ? hit[at.nth].position : null;
    }

    /** 笔记里第一个是这段 LaTeX 的公式 */
    static locate(src: string, latex: string): { position: number; tex: string } | null {
        const want = (latex || '').replace(/\s+/g, '');
        if (!want) return null;
        for (const m of maskCode(src).matchAll(FORMULA)) {
            if (this.strip(m[0]) === want) {
                const index = m.index ?? 0;
                return { position: index, tex: src.slice(index, index + m[0].length) };
            }
        }
        return null;
    }
}
