// 回归测试：外面改了 .hinote/highlights/<note>.json，插件不能拿内存里那份盖回去
// （2026-10-22，Types 06：hinote.py 把三条批注里的 C 改成 Z，开着笔记的插件在 ~10s 内
// 把旧内容写了回去，三次。只有先 Cmd-P → Reload HiNote 才写得进去）。
// 现在：写盘前先看盘上那份有没有被动过，动过就三方合并；轮询还会把外面的写读回侧栏。
// 运行：node scripts/test-external-write-reload.mjs
import assert from "node:assert/strict";
import { loadTs } from "./lib/load-ts.mjs";

const { HiNoteDataManager } = await loadTs("src/storage/HiNoteDataManager.ts");
const { HighlightRepository } = await loadTs("src/repositories/HighlightRepository.ts");
const { HighlightFileWatcher } = await loadTs("src/storage/HighlightFileWatcher.ts");

const NOTE = "Part II/Types/Notes/06 Existential Types.md";
const STORE = "/.hinote/highlights/part_ii_types_notes_06_existential_types.md.json";

/** 内存里的一个假 vault adapter，mtime 每写一次就变 */
function makeAdapter() {
    const files = new Map();
    let clock = 1000;
    return {
        files,
        async read(path) {
            if (!files.has(path)) throw new Error(`ENOENT ${path}`);
            return files.get(path).data;
        },
        async write(path, data) {
            files.set(path, { data, mtime: ++clock });
        },
        async stat(path) {
            const f = files.get(path);
            return f ? { type: "file", mtime: f.mtime, size: f.data.length, ctime: f.mtime } : null;
        },
        async exists(path) { return files.has(path); },
        async remove(path) { files.delete(path); },
        async mkdir() {},
        async list() { return { files: [...files.keys()], folders: [] }; },
    };
}

function makeApp(adapter) {
    return { vault: { adapter } };
}

/** 盘上的样子：highlights 直接写成 HiNote 的 2.0 格式 */
function diskFile(highlights) {
    return JSON.stringify({ version: "2.0", lastModified: Date.now(), highlights }, null, 2);
}

function highlight(text, comments, extra = {}) {
    return { text, position: 100, created: 1, updated: 1, comments, ...extra };
}

const agent = (content) => ({ id: "comment-1-agentab12c", content, created: 1, updated: 1 });
const hers = (content, id = "comment-2") => ({ id, content, created: 2, updated: 2 });

async function setup(initial) {
    const adapter = makeAdapter();
    adapter.files.set(STORE, { data: diskFile(initial), mtime: 1 });
    const dataManager = new HiNoteDataManager(makeApp(adapter));
    await dataManager.initialize();
    const repository = new HighlightRepository(dataManager);
    // 插件读一遍（侧栏显示这个笔记就会读），缓存和 base 都有了
    const cached = await repository.getFileHighlights(NOTE);
    return { adapter, dataManager, repository, cached };
}

/** 外面（hinote.py）写一次 */
function outsideWrite(adapter, highlights) {
    adapter.files.set(STORE, { data: diskFile(highlights), mtime: 9000 + Math.random() });
}

const onDisk = (adapter) => JSON.parse(adapter.files.get(STORE).data).highlights;
const commentsOf = (highlights, id) => highlights[id].comments.map(c => c.content);

// --- 1. 外面改了批注，插件之后的写盘不能把它盖回去 ---
{
    const { adapter, repository, cached } = await setup({
        h1: highlight("$\\exists$", [agent("C is the client's answer type")]),
    });
    assert.equal(cached[0].comments[0].content, "C is the client's answer type");

    outsideWrite(adapter, { h1: highlight("$\\exists$", [agent("Z is the client's answer type")]) });

    // 锚点维护那类写盘：拿内存里那份（还是旧文字）写回去
    await repository.saveFileHighlights(NOTE, cached);

    assert.deepEqual(commentsOf(onDisk(adapter), "h1"), ["Z is the client's answer type"],
        "the outside write must survive the plugin's next save");
    assert.deepEqual(repository.getCachedHighlights(NOTE)[0].comments.map(c => c.content),
        ["Z is the client's answer type"], "and the plugin's own copy must pick it up");
}

// --- 2. 不重载插件，轮询就把外面的写读进侧栏 ---
{
    const { adapter, repository } = await setup({
        h1: highlight("$\\exists$", [agent("C is the client's answer type")]),
    });
    const changed = [];
    const watcher = new HighlightFileWatcher(
        { app: { workspace: { getActiveFile: () => ({ path: NOTE, extension: "md" }), getLeavesOfType: () => [] } } },
        repository,
        { emitFigureHighlightChange: (path) => changed.push(path) }
    );

    assert.deepEqual(await watcher.check(), [], "nothing changed on disk yet");

    outsideWrite(adapter, { h1: highlight("$\\exists$", [agent("Z is the client's answer type")]) });

    assert.deepEqual(await watcher.check(), [NOTE], "the external write is noticed");
    assert.deepEqual(changed, [NOTE], "and the side panel is told to redraw");
    assert.deepEqual(repository.getCachedHighlights(NOTE)[0].comments.map(c => c.content),
        ["Z is the client's answer type"], "the card now shows the new text without a reload");

    assert.deepEqual(await watcher.check(), [], "and it does not keep reloading the same file");
}

// --- 3. 两边都有改动：她这边新写的批注和外面改的那条都要留住 ---
{
    const { adapter, repository, cached } = await setup({
        h1: highlight("$\\exists$", [agent("C is the client's answer type")]),
        h2: highlight("pack", []),
    });

    // 她在 Obsidian 里给 h2 写了一条批注（还没写盘）
    const mine = JSON.parse(JSON.stringify(cached));
    mine.find(h => h.id === "h2").comments.push({ id: "comment-9", content: "pack hides the type", createdAt: 3, updatedAt: 3 });

    outsideWrite(adapter, {
        h1: highlight("$\\exists$", [agent("Z is the client's answer type")]),
        h2: highlight("pack", []),
    });

    await repository.saveFileHighlights(NOTE, mine);

    const disk = onDisk(adapter);
    assert.deepEqual(commentsOf(disk, "h1"), ["Z is the client's answer type"], "the agent's rewrite stands");
    assert.deepEqual(commentsOf(disk, "h2"), ["pack hides the type"], "her unsaved comment is written too");
}

// --- 4. 她的批注永远不丢：外面的写把它删了，这边又改过这条高亮 ---
{
    const { adapter, repository, cached } = await setup({
        h1: highlight("$\\exists$", [agent("C"), hers("mine: the mould is hidden")]),
    });

    const mine = JSON.parse(JSON.stringify(cached));
    mine[0].position = 140;                               // 这边动过（打字让它挪了）

    outsideWrite(adapter, { h1: highlight("$\\exists$", [agent("Z")], { position: 100 }) });

    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
        await repository.saveFileHighlights(NOTE, mine);
    } finally {
        console.warn = realWarn;
    }

    const disk = onDisk(adapter);
    assert.deepEqual(commentsOf(disk, "h1"), ["Z", "mine: the mould is hidden"],
        "her comment stays, and the agent comment takes the outside text");
    assert.ok(warnings.some(w => w.includes("an outside write removed it")),
        "and keeping it is logged, not silent");
}

// --- 5. 在 Obsidian 里删掉的，合并不能让它回来 ---
{
    const { adapter, repository, cached } = await setup({
        h1: highlight("$\\exists$", [agent("C")]),
        h2: highlight("pack", [hers("delete me")]),
    });

    const mine = cached.filter(h => h.id !== "h2");       // 她把 h2 整条删了
    outsideWrite(adapter, {
        h1: highlight("$\\exists$", [agent("Z")]),
        h2: highlight("pack", [hers("delete me")]),       // 外面那份没碰 h2
    });

    await repository.saveFileHighlights(NOTE, mine);

    const disk = onDisk(adapter);
    assert.deepEqual(Object.keys(disk), ["h1"], "the highlight she deleted must not come back");
    assert.deepEqual(commentsOf(disk, "h1"), ["Z"], "and the outside rewrite is still there");
}

// --- 6. 盘上那份没人动过：照常写，不走合并 ---
{
    const { adapter, repository, cached } = await setup({
        h1: highlight("$\\exists$", [agent("C")]),
    });

    const mine = JSON.parse(JSON.stringify(cached));
    mine[0].comments[0].content = "edited in Obsidian";
    await repository.saveFileHighlights(NOTE, mine);

    assert.deepEqual(commentsOf(onDisk(adapter), "h1"), ["edited in Obsidian"],
        "a normal save still just writes what the plugin has");

    // 自己写的那次不能被当成"外面改了"，否则每次写盘都要合并一遍
    const watcher = new HighlightFileWatcher(
        { app: { workspace: { getActiveFile: () => ({ path: NOTE, extension: "md" }), getLeavesOfType: () => [] } } },
        repository,
        { emitFigureHighlightChange: () => {} }
    );
    assert.deepEqual(await watcher.check(), [], "the plugin's own write is not seen as an outside write");
}

// --- 7. 撤销功能读一遍存着的那份，不能把"上次见到的"重新盖章 ---
{
    const { adapter, repository, cached } = await setup({
        h1: highlight("$\\exists$", [agent("C is the client's answer type")]),
    });

    outsideWrite(adapter, { h1: highlight("$\\exists$", [agent("Z is the client's answer type")]) });

    // HighlightUndo 每次改动前都读一遍（record → readStoredHighlights）。
    // 如果这一读也算"我见过了"，base 就变成了盘上那份，下面那次写盘又会把外面的盖掉。
    const seen = await repository.readStoredHighlights(NOTE);
    assert.deepEqual(seen[0].comments.map(c => c.content), ["Z is the client's answer type"],
        "the undo recorder reads what is actually on disk");

    await repository.saveFileHighlights(NOTE, cached);

    assert.deepEqual(commentsOf(onDisk(adapter), "h1"), ["Z is the client's answer type"],
        "and reading it must not cost the outside write");
}

console.log("external-write reload: ok");
