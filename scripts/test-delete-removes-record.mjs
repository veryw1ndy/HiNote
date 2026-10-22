// 回归测试：在 HiNote 里删掉一条高亮，.hinote/highlights/<note>.json 里的记录要跟着删
// （2026-10-22，Types 06：'Extra numbers are harmless' 和 'inside that component' 的 ==
// 从笔记里去掉了，两条记录连批注留在 JSON 里，面板上也看不见，只能跑 hinote.py drop）。
// 运行：node scripts/test-delete-removes-record.mjs
import assert from "node:assert/strict";
import { loadTs } from "./lib/load-ts.mjs";

globalThis.window = { setTimeout: (fn, ms) => setTimeout(fn, ms) };

const { findStoredHighlightToDelete } = await loadTs("src/services/highlight/HighlightMatchStrategies.ts");
const { HighlightManager } = await loadTs("src/services/HighlightManager.ts");
const { HighlightDeletionManager } = await loadTs("src/views/highlight/actions/HighlightDeletionManager.ts");

const NOTE = "Part II/Types/Notes/06 Existential Types.md";
const file = { path: NOTE, basename: "06 Existential Types", extension: "md" };

function stored(id, text, position, extra = {}) {
    return { id, text, position, filePath: NOTE, comments: [], ...extra };
}

/** 只有缓存和「盘上那份」的最小仓储 */
function makeRepo(initial) {
    let list = initial;
    const writes = [];
    return {
        writes,
        get stored() { return list; },
        getCachedHighlights: () => list,
        getFileHighlights: async () => list,
        readStoredHighlights: async () => list,
        saveFileHighlights: async (p, hs) => { list = hs; writes.push(hs.map(h => h.id)); },
        deleteFileHighlights: async () => { list = []; writes.push([]); },
    };
}

const noEvents = {
    emitHighlightDelete() {}, emitCommentDelete() {}, emitHighlightUpdate() {},
    emitCommentUpdate() {}, emitFigureHighlightChange() {},
};

// --- 1. 要删的是哪条记录：ID 过时了也要找得到 ---
{
    const candidates = [
        stored("highlight-1-9557", "Extra numbers are harmless", 10488),
        stored("highlight-2-100", "data abstraction", 2474),
    ];

    // 卡片的 ID 是重新算过的，和存的那条已经不是一个
    const card = { id: "highlight-999-10488", text: "Extra numbers are harmless", position: 10488 };
    assert.equal(findStoredHighlightToDelete(card, candidates)?.id, "highlight-1-9557",
        "a stale id must still find the stored record");

    // 同一段文字存了两份又离得近：重新定位时会放弃，删除时挑最近的那份
    const twins = [stored("a", "\\\\", 500), stored("b", "\\\\", 560)];
    assert.equal(findStoredHighlightToDelete({ id: "gone", text: "\\\\", position: 555 }, twins)?.id, "b",
        "two records with the same text: delete the nearest one");

    // 真的没有这段文字：什么都不删
    assert.equal(findStoredHighlightToDelete({ id: "gone", text: "not here", position: 1 }, candidates), null,
        "no stored record for that text: delete nothing");

    // 图里的高亮只认 ID：它的文字也可能出现在正文里
    const figure = [stored("fig", "bool", 0, { figure: { kind: "math", leaves: ["x"] } })];
    assert.equal(findStoredHighlightToDelete({ id: "other", text: "bool", position: 0, figure: { kind: "math", leaves: ["x"] } }, figure), null,
        "a figure highlight is matched by id only");
}

// --- 2. removeHighlight：ID 过时也删得掉，真找不到就说找不到 ---
{
    const repo = makeRepo([
        stored("highlight-1-9557", "Extra numbers are harmless", 10488, {
            comments: [{ id: "comment-1-agentqc9yp", content: "ℕ has more values than bool" }],
        }),
        stored("highlight-2-100", "data abstraction", 2474),
    ]);
    const manager = new HighlightManager({}, repo, noEvents, {});

    const removed = await manager.removeHighlight(file, {
        id: "highlight-999-10488", text: "Extra numbers are harmless", position: 10488, filePath: NOTE,
    });

    assert.equal(removed, true, "the delete reports success");
    assert.deepEqual(repo.stored.map(h => h.id), ["highlight-2-100"], "and the record is gone from storage");
    assert.deepEqual(repo.writes, [["highlight-2-100"]], "written once");
}
{
    const repo = makeRepo([stored("highlight-2-100", "data abstraction", 2474)]);
    const manager = new HighlightManager({}, repo, noEvents, {});
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    let removed;
    try {
        removed = await manager.removeHighlight(file, { id: "nope", text: "never stored", position: 1, filePath: NOTE });
    } finally {
        console.warn = realWarn;
    }

    assert.equal(removed, false, "nothing matched: say so");
    assert.deepEqual(repo.writes, [], "and write nothing");
    assert.ok(warnings.some(w => w.includes("nothing deleted")), "the miss is logged");
}

// --- 3. 面板上删一条高亮：先删记录，再去掉笔记里的 == ---
{
    const order = [];
    const repo = makeRepo([
        stored("highlight-1-9557", "Extra numbers are harmless", 10488, {
            comments: [{ id: "comment-1-agentqc9yp", content: "ℕ has more values than bool" }],
        }),
        stored("highlight-2-100", "data abstraction", 2474),
    ]);
    repo.saveFileHighlights = async (p, hs) => { order.push("record"); repo.writes.push(hs.map(h => h.id)); };

    let noteContent = "a ==Extra numbers are harmless== b ==data abstraction== c";
    const plugin = {
        settings: {},
        eventManager: noEvents,
        highlightManager: new HighlightManager({}, repo, noEvents, {}),
        app: {
            vault: {
                getAbstractFileByPath: (p) => (p === NOTE ? file : null),
                process: async (f, fn) => { order.push("note"); noteContent = fn(noteContent); },
            },
        },
    };
    const deletion = new HighlightDeletionManager(plugin);

    const ok = await deletion.deleteHighlight(
        { id: "highlight-1-9557", text: "Extra numbers are harmless", position: 2, filePath: NOTE },
        true, true
    );

    assert.equal(ok, true);
    assert.deepEqual(order, ["record", "note"],
        "the stored record goes first, while the note still has the == to match against");
    assert.deepEqual(repo.writes, [["highlight-2-100"]], "the record is removed from the JSON");
    assert.ok(!noteContent.includes("==Extra numbers are harmless=="), "and the == is stripped from the note");
    assert.ok(noteContent.includes("Extra numbers are harmless"), "the words stay, only the marks go");
}

// --- 4. 记录删不掉就别动笔记：不能留下一条谁也看不见的记录 ---
{
    const repo = makeRepo([stored("highlight-2-100", "data abstraction", 2474)]);
    let noteContent = "a ==gone from storage== b";
    const plugin = {
        settings: {},
        eventManager: noEvents,
        highlightManager: new HighlightManager({}, repo, noEvents, {}),
        app: {
            vault: {
                getAbstractFileByPath: () => file,
                process: async (f, fn) => { noteContent = fn(noteContent); },
            },
        },
    };
    const deletion = new HighlightDeletionManager(plugin);

    const realWarn = console.warn;
    console.warn = () => {};
    let ok;
    try {
        ok = await deletion.deleteHighlight(
            { id: "nope", text: "gone from storage", position: 2, filePath: NOTE }, true, true
        );
    } finally {
        console.warn = realWarn;
    }

    assert.equal(ok, false, "the delete reports failure instead of a silent half-delete");
    assert.equal(noteContent, "a ==gone from storage== b", "the note is left alone");
    assert.deepEqual(repo.writes, [], "and nothing is written");
}

// --- 5. 撤销还拿得到删之前的那份（beforeWrite 经过仓储，顺序没变） ---
{
    const before = [];
    const repo = makeRepo([
        stored("h1", "Extra numbers are harmless", 10488, { comments: [{ id: "c1", content: "hers" }] }),
        stored("h2", "data abstraction", 2474),
    ]);
    const save = repo.saveFileHighlights;
    repo.saveFileHighlights = async (p, hs) => {
        before.push((await repo.readStoredHighlights(p)).map(h => h.id));   // HighlightUndo.record 就是这么记的
        await save(p, hs);
    };
    const manager = new HighlightManager({}, repo, noEvents, {});
    await manager.removeHighlight(file, { id: "h1", text: "Extra numbers are harmless", position: 10488, filePath: NOTE });

    assert.deepEqual(before, [["h1", "h2"]], "undo sees the list as it was before the delete");
    assert.deepEqual(repo.stored.map(h => h.id), ["h2"]);
}

console.log("delete removes the stored record: ok");
