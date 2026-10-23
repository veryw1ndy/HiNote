import type { HighlightInfo } from '../../types/highlight';
import type { HighlightInfo as HiNote } from '../../types/highlight';

export type HighlightMatchConfidence =
    | 'id'
    | 'block-text'
    | 'text-position'
    | 'context'
    | 'unique-text';

export interface HighlightMatchResult {
    highlight: HiNote;
    confidence: HighlightMatchConfidence;
}

export interface HighlightMatchOptions {
    usedIds?: Set<string>;
    /** 不按「文字只出现一次」来配，pairStoredHighlights 自己在第二轮做 */
    skipUniqueText?: boolean;
}

const TEXT_POSITION_THRESHOLD = 500;
const TEXT_POSITION_TIE_MARGIN = 200;
const CONTEXT_POSITION_THRESHOLD = 1200;
const CONTEXT_SCORE_THRESHOLD = 1.35;
const CONTEXT_TIE_MARGIN = 0.2;

export function findStoredHighlightMatch(
    target: HiNote,
    candidates: HiNote[],
    options: HighlightMatchOptions = {}
): HighlightMatchResult | null {
    // 图里的高亮只认 ID：它的文字也可能在正文里出现，按文字匹配会把正文高亮配到图上去。
    const sameKind = candidates.filter(candidate => !candidate.figure === !target.figure);
    const availableCandidates = filterAvailableCandidates(sameKind, options.usedIds);
    if (target.figure) {
        const idMatch = findIdMatch(target, availableCandidates);
        return idMatch ? { highlight: idMatch, confidence: 'id' } : null;
    }
    if (availableCandidates.length === 0) return null;

    const idMatch = findIdMatch(target, availableCandidates);
    if (idMatch) return { highlight: idMatch, confidence: 'id' };

    const blockTextMatch = findBlockTextMatch(target, availableCandidates);
    if (blockTextMatch) return { highlight: blockTextMatch, confidence: 'block-text' };

    const textPositionMatch = findTextPositionMatch(target, availableCandidates);
    if (textPositionMatch) return { highlight: textPositionMatch, confidence: 'text-position' };

    const contextMatch = findContextMatch(target, availableCandidates);
    if (contextMatch) return { highlight: contextMatch, confidence: 'context' };

    if (options.skipUniqueText) return null;
    const uniqueTextMatch = findUniqueTextMatch(target, availableCandidates);
    if (uniqueTextMatch) return { highlight: uniqueTextMatch, confidence: 'unique-text' };

    return null;
}

export interface StoredHighlightPair {
    match: HighlightMatchResult | null;
}

/**
 * 把一个笔记里提取到的全部高亮，一次性和存下来的记录配对。每条记录最多配一个高亮。
 *
 * 编辑模式的批注图标、阅读模式的 <mark> 和侧栏的卡片都必须用这一个函数：以前三处各配各的，
 * 编辑模式下的图标拿不到记录的 ID，点它时侧栏只好按文字找卡片，找到的是同名的另一张
 * （图里的 home MTSO、标题里的同一个词）；正文里同一个词出现两次时，两个都显示同一条批注。
 *
 * 先用有把握的办法（ID、块、位置、上下文）配，剩下的才按文字配，而且只在两边都只剩
 * 一个同样文字的时候：否则第一个出现的会抢走本该属于后面那个的记录。
 */
export function pairStoredHighlights(targets: HiNote[], candidates: HiNote[]): StoredHighlightPair[] {
    const usedIds = new Set<string>();
    const pairs: StoredHighlightPair[] = targets.map(() => ({ match: null }));

    targets.forEach((target, i) => {
        const match = findStoredHighlightMatch(target, candidates, { usedIds, skipUniqueText: true });
        if (match?.highlight.id) {
            usedIds.add(match.highlight.id);
            pairs[i].match = match;
        }
    });

    const leftover = (text: string) => targets.filter((t, i) => !pairs[i].match && !t.figure && t.text === text).length;
    targets.forEach((target, i) => {
        if (pairs[i].match || target.figure || !target.text || leftover(target.text) !== 1) return;
        const available = filterAvailableCandidates(candidates.filter(c => !c.figure), usedIds);
        const match = findUniqueTextMatch(target, available);
        if (match?.id) {
            usedIds.add(match.id);
            pairs[i].match = { highlight: match, confidence: 'unique-text' };
        }
    });

    return pairs;
}

/**
 * 删除一条高亮时，要删的是哪条存下来的记录。
 *
 * 比重新定位锚点时松一点，而且必须松：匹配不上就只删掉笔记里的 ==，记录和批注留在
 * .hinote/highlights/<note>.json 里，面板上也看不见了（正文里提取不到的记录不列出来），
 * 只能去跑 hinote.py drop。同一段文字存了两份又离得近的时候，findStoredHighlightMatch
 * 会放弃（写回去可能写到另一份上）；删除没有这个顾虑：卡片自己带着位置，挑最近的那份。
 * 图里的高亮还是只认 ID：它的文字也可能出现在正文里，删错了记录连高亮本身都没了。
 */
export function findStoredHighlightToDelete(
    target: HiNote,
    candidates: HiNote[]
): HiNote | null {
    const match = findStoredHighlightMatch(target, candidates);
    if (match) return match.highlight;
    if (target.figure || !target.text) return null;

    const sameText = candidates.filter(candidate => !candidate.figure && candidate.text === target.text);
    if (sameText.length === 0) return null;
    if (sameText.length === 1) return sameText[0];
    if (typeof target.position !== 'number') return null;

    const nearest = sameText
        .filter(candidate => typeof candidate.position === 'number')
        .sort((a, b) => Math.abs(a.position! - target.position!) - Math.abs(b.position! - target.position!))[0];

    return nearest || null;
}

export function canUpdateStoredHighlight(confidence: HighlightMatchConfidence): boolean {
    return confidence === 'id' ||
        confidence === 'block-text' ||
        confidence === 'text-position' ||
        confidence === 'context';
}

function filterAvailableCandidates(candidates: HiNote[], usedIds?: Set<string>): HiNote[] {
    if (!usedIds) return candidates;
    return candidates.filter(candidate => !candidate.id || !usedIds.has(candidate.id));
}

function findIdMatch(target: HiNote, candidates: HiNote[]): HiNote | null {
    if (!target.id) return null;
    return candidates.find(candidate => candidate.id === target.id) || null;
}

function findBlockTextMatch(target: HiNote, candidates: HiNote[]): HiNote | null {
    if (!target.blockId) return null;

    const blockCandidates = candidates.filter(candidate => candidate.blockId === target.blockId);
    if (blockCandidates.length === 0) return null;

    const exactText = blockCandidates.find(candidate => candidate.text === target.text);
    if (exactText) return exactText;

    if (blockCandidates.length === 1 && getContextScore(target, blockCandidates[0]) >= CONTEXT_SCORE_THRESHOLD) {
        return blockCandidates[0];
    }

    return null;
}

function findTextPositionMatch(target: HiNote, candidates: HiNote[]): HiNote | null {
    if (!target.text || typeof target.position !== 'number') return null;

    const sortedCandidates = candidates
        .filter(candidate =>
            candidate.text === target.text &&
            typeof candidate.position === 'number'
        )
        .sort((a, b) =>
            Math.abs(a.position - target.position) -
            Math.abs(b.position - target.position)
        );

    const best = sortedCandidates[0];
    if (!best || typeof best.position !== 'number') return null;

    // 同一段文字存了两份、离得都不远（表格里两个格子都是 ==\\==）：靠位置分不清是哪一个。
    // 这时随便挑最近的，文字一挪位置，批注就跑到另一个格子上，还会被写回去。
    // 让后面的上下文匹配来判断，它拿不准时自己会放弃。
    const second = sortedCandidates[1];
    if (second && Math.abs(second.position - target.position) - Math.abs(best.position - target.position) < TEXT_POSITION_TIE_MARGIN) {
        return null;
    }

    return Math.abs(best.position - target.position) < TEXT_POSITION_THRESHOLD
        ? best
        : null;
}

function findContextMatch(target: HiNote, candidates: HiNote[]): HiNote | null {
    const scored = candidates
        .map(candidate => ({
            candidate,
            score: getContextScore(target, candidate)
        }))
        .filter(item => item.score >= CONTEXT_SCORE_THRESHOLD)
        .sort((a, b) => b.score - a.score);

    if (scored.length === 0) return null;
    if (scored.length > 1 && scored[0].score - scored[1].score < CONTEXT_TIE_MARGIN) {
        return null;
    }

    const best = scored[0].candidate;
    if (!hasPositionNear(target, best, CONTEXT_POSITION_THRESHOLD) &&
        !hasStrongTwoSidedContext(target, best)) {
        return null;
    }

    return best;
}

function findUniqueTextMatch(target: HiNote, candidates: HiNote[]): HiNote | null {
    if (!target.text) return null;

    const textMatches = candidates.filter(candidate => candidate.text === target.text);
    return textMatches.length === 1 ? textMatches[0] : null;
}

function getContextScore(target: HiNote, candidate: HiNote): number {
    let score = 0;

    if (target.blockId && candidate.blockId && target.blockId === candidate.blockId) {
        score += 0.75;
    }

    if (hasPositionNear(target, candidate, CONTEXT_POSITION_THRESHOLD)) {
        score += 0.25;
    }

    score += getAnchorScore(target.contextBefore, candidate.contextBefore);
    score += getAnchorScore(target.contextAfter, candidate.contextAfter);
    score += getTextSimilarityScore(target, candidate);

    return score;
}

function getAnchorScore(a?: string, b?: string): number {
    if (!a || !b) return 0;

    const normalizedA = normalizeText(a);
    const normalizedB = normalizeText(b);
    if (!normalizedA || !normalizedB) return 0;

    if (normalizedA === normalizedB) return 0.65;
    if (normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA)) return 0.45;

    const similarity = getDiceSimilarity(normalizedA, normalizedB);
    return similarity >= 0.72 ? 0.35 : 0;
}

function getTextSimilarityScore(target: HiNote, candidate: HiNote): number {
    if (target.text === candidate.text) return 0.5;

    const targetText = normalizeText(target.textFingerprint || target.text);
    const candidateText = normalizeText(candidate.textFingerprint || candidate.text);
    const similarity = getDiceSimilarity(targetText, candidateText);

    if (similarity >= 0.85) return 0.45;
    if (similarity >= 0.65) return 0.3;
    if (similarity >= 0.45) return 0.15;
    return 0;
}

function hasStrongTwoSidedContext(target: HiNote, candidate: HiNote): boolean {
    return getAnchorScore(target.contextBefore, candidate.contextBefore) >= 0.35 &&
        getAnchorScore(target.contextAfter, candidate.contextAfter) >= 0.35;
}

function hasPositionNear(a: HighlightInfo, b: HighlightInfo, threshold: number): boolean {
    return typeof a.position === 'number' &&
        typeof b.position === 'number' &&
        Math.abs(a.position - b.position) < threshold;
}

function normalizeText(value: string): string {
    return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function getDiceSimilarity(a: string, b: string): number {
    if (!a || !b) return 0;
    if (a === b) return 1;

    const aTokens = getBigrams(a);
    const bTokens = getBigrams(b);
    if (aTokens.length === 0 || bTokens.length === 0) {
        return a === b ? 1 : 0;
    }

    const counts = new Map<string, number>();
    for (const token of aTokens) {
        counts.set(token, (counts.get(token) || 0) + 1);
    }

    let overlap = 0;
    for (const token of bTokens) {
        const count = counts.get(token) || 0;
        if (count > 0) {
            overlap++;
            counts.set(token, count - 1);
        }
    }

    return (2 * overlap) / (aTokens.length + bTokens.length);
}

function getBigrams(value: string): string[] {
    const compact = value.replace(/\s+/g, '');
    if (compact.length < 2) return compact ? [compact] : [];

    const bigrams: string[] = [];
    for (let i = 0; i < compact.length - 1; i++) {
        bigrams.push(compact.slice(i, i + 2));
    }

    return bigrams;
}
