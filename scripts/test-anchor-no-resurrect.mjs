// 回归测试：锚点维护那次延迟写盘不能让删掉的批注复活（2026-10-22，Types 06 的
// "$\alpha$ names the hidden mould"：删掉批注、不重载、再划同一段文字，批注自己回来了）。
// 运行：node scripts/test-anchor-no-resurrect.mjs
import assert from "node:assert/strict";
import { loadTs } from "./lib/load-ts.mjs";

globalThis.window = { setTimeout: (fn, ms) => setTimeout(fn, ms) };

const { HighlightMatcher } = await loadTs("src/services/highlight/HighlightMatcher.ts");
const { HighlightManager } = await loadTs("src/services/HighlightManager.ts");

const file = { path: "note.md", basename: "note", extension: "md" };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 只有缓存和「盘上那份」的最小仓储，saveFileHighlights 记下每次写了什么 */
function makeRepo(initial) {
    let stored = initial;
    const writes = [];
    return {
        writes,
        get stored() { return stored; },
        set stored(v) { stored = v; },
        getCachedHighlights: (p) => (p === file.path ? stored : null),
        getFileHighlights: async (p) => (p === file.path ? stored : []),
        saveFileHighlights: async (p, hs) => { stored = hs; writes.push(hs.map(h => h.id)); },
        deleteFileHighlights: async () => { stored = []; writes.push([]); },
    };
}

// --- 1. 排了定时器之后把一条高亮删掉，写盘不能把它带回来 ---
{
    const kept = { id: "kept", text: "one", position: 100, contextBefore: "a", contextAfter: "b", comments: [{ id: "c1", content: "keep me" }] };
    const doomed = { id: "doomed", text: "two", position: 200, contextBefore: "c", contextAfter: "d", comments: [{ id: "c2", content: "⚠️ delete me" }] };
    const repo = makeRepo([kept, doomed]);
    const matcher = new HighlightMatcher(() => repo);

    // 正文里两条都挪了位置 → 两条都会排进待写的锚点补丁
    const extracted = [
        { text: "one", position: 103, contextBefore: "a", contextAfter: "b" },
        { text: "two", position: 204, contextBefore: "c", contextAfter: "d" },
    ];
    const merged = matcher.mergeHighlightsWithComments(extracted, repo.stored, file);
    assert.equal(merged.length, 2);
    assert.equal(merged[1].comments[0].content, "⚠️ delete me", "stored comment should merge onto the drifted highlight");

    // 定时器还没到，用户把这条批注删了（整条高亮一起删）
    repo.stored = [kept];

    await sleep(250);

    assert.deepEqual(repo.writes.at(-1), ["kept"], "the anchor write must not resurrect the deleted highlight");
    assert.ok(!repo.stored.some(h => h.id === "doomed"), "deleted highlight is gone for good");
    assert.equal(repo.stored[0].position, 103, "the surviving highlight still gets its anchor updated");
}

// --- 2. 一个文件连着合并好几次，只写一次盘 ---
{
    const h = { id: "h", text: "one", position: 100, contextBefore: "a", contextAfter: "b", comments: [{ id: "c", content: "x" }] };
    const repo = makeRepo([h]);
    const matcher = new HighlightMatcher(() => repo);
    for (const p of [101, 102, 103]) {
        matcher.mergeHighlightsWithComments(
            [{ text: "one", position: p, contextBefore: "a", contextAfter: "b" }], repo.stored, file);
    }
    await sleep(250);
    assert.equal(repo.writes.length, 1, "a burst of merges should coalesce into one write");
    assert.equal(repo.stored[0].position, 103, "the last position wins");
}

// --- 3. 锚点没动就别写盘（别把自己写成一个循环） ---
{
    const h = { id: "h", text: "one", position: 100, contextBefore: "a", contextAfter: "b", comments: [{ id: "c", content: "x" }] };
    const repo = makeRepo([h]);
    const matcher = new HighlightMatcher(() => repo);
    matcher.mergeHighlightsWithComments(
        [{ text: "one", position: 100, contextBefore: "a", contextAfter: "b" }], repo.stored, file);
    await sleep(250);
    assert.equal(repo.writes.length, 0, "an unchanged anchor should write nothing");
}

// --- 4. 面板上那条的 ID 跟盘上存的不是一个时，删除不能悄悄失败 ---
{
    const stored = [{ id: "highlight-325562655-12515", text: "$\\alpha$ names the hidden mould", position: 12519,
                      contextBefore: "two new names,", contextAfter: "and $x$ names the body,",
                      comments: [{ id: "c", content: "⚠️" }] }];
    const repo = makeRepo(stored);
    const manager = new HighlightManager({}, repo, null, {});

    // 同一段文字，重新算过的 ID（位置漂了两格）
    const fromPanel = { id: "highlight-515397434-12521", text: "$\\alpha$ names the hidden mould", position: 12521,
                        contextBefore: "two new names,", contextAfter: "and $x$ names the body," };
    assert.equal(await manager.removeHighlight(file, fromPanel), true, "a drifted id must still delete the stored record");
    assert.equal(repo.stored.length, 0, "the record is really gone");

    // 真的不存在的那条照旧返回 false
    const empty = makeRepo([]);
    const m2 = new HighlightManager({}, empty, null, {});
    assert.equal(await m2.removeHighlight(file, fromPanel), false, "nothing to delete still reports false");
}

console.log("anchor updates never resurrect a deleted comment: ok");
