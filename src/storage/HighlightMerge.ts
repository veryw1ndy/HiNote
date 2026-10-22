import { OptimizedComment, OptimizedHighlight } from './HighlightDataFormat';

export type HighlightMap = { [id: string]: OptimizedHighlight };

/**
 * 盘上那份被别人改了，怎么和内存里这份合起来。
 *
 * .hinote/highlights/<note>.json 不只有插件在写：Tools/hinote/hinote.py 这类脚本也写。
 * 插件把内存里的那份直接写回去，外面刚写进去的就没了（2026-10-22，Types 06 的三条批注
 * 被插件的旧内容覆盖了三次）。所以写之前先比一下：
 *
 *   base   上一次插件自己读到或写出去的那份（两边都从它分出来）
 *   mine   内存里现在这份（插件要写的）
 *   theirs 盘上现在这份（外面写进去的）
 *
 * 规则（三方合并，逐条高亮、逐条批注比对）：
 *  - 内存这份和 base 一样 → 插件没改过东西，拿盘上那份（这就是"重新读一遍"）；
 *  - 只有内存这份改了 → 拿内存这份；
 *  - 两边都改了 → 按批注的 id 合：id 以 `-agent<后缀>` 结尾的是脚本写的，可以被改写、删掉；
 *    其它批注都是 Yawen 自己写的，合不了的时候留她那份，并且记一条日志。
 *  - 在这里（内存里）删掉的，不会因为合并又回来：删除也是一种改动。
 */
export const AGENT_COMMENT_ID = /-agent[a-z0-9]*$/;

export function isAgentComment(id: string | undefined): boolean {
    return !!id && AGENT_COMMENT_ID.test(id);
}

export interface HighlightMergeResult {
    highlights: HighlightMap;
    /** 结果和内存里那份不一样：缓存和侧栏要刷新 */
    changedFromMine: boolean;
    /** 结果和盘上那份不一样：要写盘 */
    changedFromTheirs: boolean;
    /** 合不了、或者外面的写动到了她的批注，留给日志的话 */
    notes: string[];
}

/** 把对象的键排序后再 JSON，拿来比"一样不一样"（两边写出来的键顺序不一定相同） */
function canon(value: unknown): string {
    return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>).sort()) {
            const inner = (value as Record<string, unknown>)[key];
            if (inner === undefined) continue;
            out[key] = sortKeys(inner);
        }
        return out;
    }
    return value;
}

function same(a: unknown, b: unknown): boolean {
    if (a === undefined && b === undefined) return true;
    if (a === undefined || b === undefined) return false;
    return canon(a) === canon(b);
}

function herComments(highlight: OptimizedHighlight | undefined): OptimizedComment[] {
    return (highlight?.comments || []).filter(comment => !isAgentComment(comment.id));
}

function label(highlight: OptimizedHighlight | undefined, id: string): string {
    const text = highlight?.text;
    return text ? `"${text.length > 40 ? text.slice(0, 40) + '…' : text}"` : id;
}

export function mergeHighlights(
    base: HighlightMap,
    mine: HighlightMap,
    theirs: HighlightMap
): HighlightMergeResult {
    const notes: string[] = [];
    const out: HighlightMap = {};
    const ids = new Set([...Object.keys(mine), ...Object.keys(theirs), ...Object.keys(base)]);

    for (const id of ids) {
        const b = base[id];
        const m = mine[id];
        const t = theirs[id];

        if (same(m, t)) {
            if (m) out[id] = m;
            continue;
        }

        const iChanged = !same(m, b);
        const theyChanged = !same(t, b);

        // 内存里这份没动过：盘上那份说什么是什么，包括外面把它删了
        if (!iChanged) {
            if (t) {
                out[id] = t;
            } else {
                const hers = herComments(b);
                if (hers.length) {
                    notes.push(`an outside write removed ${label(b, id)} together with ${hers.length} of your comment(s)`);
                }
            }
            continue;
        }

        // 只有这边改了
        if (!theyChanged) {
            if (m) out[id] = m;
            continue;
        }

        // 两边都改了
        if (!m) {
            // 这边删了，外面改了：外面新加的她的批注不能跟着没了
            const baseIds = new Set((b?.comments || []).map(comment => comment.id));
            const newHers = herComments(t).filter(comment => !baseIds.has(comment.id));
            if (newHers.length) {
                out[id] = t;
                notes.push(`kept ${label(t, id)}, deleted here: the file on disk has ${newHers.length} comment(s) of yours on it`);
            }
            continue;
        }

        if (!t) {
            // 外面删了，这边改了：留这边的
            out[id] = m;
            notes.push(`kept ${label(m, id)}: an outside write removed it, but it had unsaved changes here`);
            continue;
        }

        out[id] = mergeOne(b, m, t, id, notes);
    }

    return {
        highlights: out,
        changedFromMine: !same(out, mine),
        changedFromTheirs: !same(out, theirs),
        notes
    };
}

/** 一条高亮两边都改了：字段逐个三方比，批注按 id 合 */
function mergeOne(
    b: OptimizedHighlight | undefined,
    m: OptimizedHighlight,
    t: OptimizedHighlight,
    id: string,
    notes: string[]
): OptimizedHighlight {
    const merged: OptimizedHighlight = { ...m };
    const keys = new Set([...Object.keys(m), ...Object.keys(t)] as Array<keyof OptimizedHighlight>);

    for (const key of keys) {
        if (key === 'comments') continue;
        const mineValue = m[key];
        const theirsValue = t[key];
        if (same(mineValue, theirsValue)) continue;
        // 这边没动这个字段 → 用盘上的；两边都动了 → 用这边的（位置、锚点是插件一直在改的）
        if (same(mineValue, b?.[key])) {
            (merged as unknown as Record<string, unknown>)[key as string] = theirsValue;
        }
    }

    merged.comments = mergeComments(b, m, t, id, notes);
    if (!merged.comments.length) delete merged.comments;
    return merged;
}

function mergeComments(
    b: OptimizedHighlight | undefined,
    m: OptimizedHighlight,
    t: OptimizedHighlight,
    id: string,
    notes: string[]
): OptimizedComment[] {
    const byId = (list: OptimizedComment[] | undefined) =>
        new Map((list || []).map(comment => [comment.id, comment]));
    const baseComments = byId(b?.comments);
    const mineComments = byId(m.comments);
    const theirsComments = byId(t.comments);

    // 顺序：内存那份的顺序在前，外面新加的接在后面
    const order = [
        ...(m.comments || []).map(comment => comment.id),
        ...(t.comments || []).map(comment => comment.id).filter(cid => !mineComments.has(cid))
    ];

    const out: OptimizedComment[] = [];
    for (const cid of order) {
        const cb = baseComments.get(cid);
        const cm = mineComments.get(cid);
        const ct = theirsComments.get(cid);

        if (!cm) {
            // 这边没有：base 里有就是这边删的，删了就别回来；否则是外面新加的
            if (!cb && ct) out.push(ct);
            continue;
        }

        if (!ct) {
            if (!cb) {
                out.push(cm);                       // 这边新加的，还没被外面看到
            } else if (isAgentComment(cid)) {
                continue;                           // 脚本写的批注，外面删了就删了
            } else {
                out.push(cm);
                notes.push(`kept your comment on ${label(m, id)}: an outside write removed it`);
            }
            continue;
        }

        if (same(cm, cb)) {
            out.push(ct);                           // 这边没碰过 → 外面写的算
        } else if (same(ct, cb)) {
            out.push(cm);                           // 外面没碰过 → 这边的算
        } else if (isAgentComment(cid)) {
            out.push(ct);                           // 脚本写的批注，可以被改写
        } else {
            out.push(cm);
            notes.push(`kept your version of a comment on ${label(m, id)}: it was edited here and on disk`);
        }
    }

    return out;
}
