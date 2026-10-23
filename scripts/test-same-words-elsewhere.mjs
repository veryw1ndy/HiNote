// 回归测试：同样的字在别处也划了（图里、标题里、同一段里），点批注图标必须打开它自己那张卡片
// （2026-10-23，PoC 04 的 home MTSO：点正文的，侧栏打开图里那张；卡片里批注只剩「展开」按钮）。
// 运行：node scripts/test-same-words-elsewhere.mjs
import assert from "node:assert/strict";
import { loadTs } from "./lib/load-ts.mjs";

const { pairStoredHighlights } = await loadTs("src/services/highlight/HighlightMatchStrategies.ts");
const { HighlightCommentResolver } = await loadTs("src/services/highlight/HighlightCommentResolver.ts");
const { HighlightCardRegistry } = await loadTs("src/components/highlight/HighlightCardRegistry.ts");
const { PreviewHighlightResolver } = await loadTs("src/views/highlight/preview/PreviewHighlightResolver.ts");
const { removeCommentInputElements } = await loadTs("src/components/comment/CommentInputCleanup.ts");

const file = { path: "04.md", basename: "04", extension: "md" };
const repoWith = stored => ({ getCachedHighlights: () => stored, findHighlightsByBlockId: () => [] });

// 1. PoC 04 原样：图里的 home MTSO 没批注，正文的有。编辑模式里正文那个图标要拿到正文记录的 ID
{
    const stored = [
        { id: "highlight-989403486-1939", text: "home MTSO", position: 4342,
          contextBefore: "Every phone belongs to one", contextAfter: ", fixed by its subscription.",
          comments: [{ id: "c1", content: "Even when ***==abroad==***, still that one home MTSO." }] },
        { id: "highlight-363517131-4296", text: "home MTSO", position: 4296,
          figure: { path: "imgs/vis-mob-cell.svg", from: [3, 0], to: [3, 9] } },
    ];
    // 正文改过，位置挪了：提取出来的 ID 是临时算的，和存的不一样
    const extracted = [{ id: "highlight-1-4370", text: "home MTSO", position: 4370,
        contextBefore: "==Every phone belongs to one== ", contextAfter: ", ==fixed by its subscription==." }];
    const [r] = new HighlightCommentResolver(repoWith(stored)).resolveAll(file, extracted);
    assert.equal(r.highlight.id, "highlight-989403486-1939", "the editor icon must carry the stored ID, not a temporary one");
    assert.equal(r.highlight.comments.length, 1);
    assert.equal(r.stored.figure, undefined, "never the figure's record");
}

// 2. 标题里和正文里都划了 tandem，只存了正文那条：标题那个不能也显示这条批注
{
    const stored = [{ id: "body", text: "tandem", position: 12400, comments: [{ id: "c", content: "x" }] }];
    const extracted = [
        { id: "t1", text: "tandem", position: 1801 },   // 标题 / 总览里的
        { id: "t2", text: "tandem", position: 12410 },  // 正文里的
    ];
    const pairs = pairStoredHighlights(extracted, stored);
    assert.equal(pairs[0].match, null, "the heading's tandem must not take the body's comment");
    assert.equal(pairs[1].match?.highlight.id, "body");
}

// 3. 两处都没法按位置判断（位置全变了）、文字一样：宁可都不配，也不能让第一个抢走
{
    const stored = [{ id: "s", text: "core", position: 90000, comments: [{ id: "c", content: "x" }] }];
    const extracted = [{ id: "a", text: "core", position: 100 }, { id: "b", text: "core", position: 5000 }];
    const pairs = pairStoredHighlights(extracted, stored);
    assert.equal(pairs[0].match, null);
    assert.equal(pairs[1].match, null);
    // 只有一个时照常按文字配上
    assert.equal(pairStoredHighlights([extracted[0]], stored)[0].match?.highlight.id, "s");
}

// 4. 侧栏：按 ID 找不到时，挑同一类、离得最近的同名卡片；不在页面上的旧卡片不算
{
    const card = (highlight, connected = true) => ({
        getHighlightId: () => highlight.id,
        getHighlight: () => highlight,
        getElement: () => ({ isConnected: connected, contains: () => false }),
    });
    const registry = new HighlightCardRegistry();
    const figureCard = card({ id: "fig", text: "home MTSO", position: 4296, figure: { path: "x.svg" } });
    const textCard = card({ id: "txt", text: "home MTSO", position: 4342 });
    const staleText = card({ id: "txt", text: "home MTSO", position: 4342 }, false);
    registry.register(staleText);
    registry.register(figureCard);
    registry.register(textCard);

    assert.equal(registry.findByHighlightId("txt"), textCard, "a card no longer on screen must not be found");
    assert.equal(registry.findByHighlight({ id: "temporary", text: "home MTSO", position: 4370 }), textCard,
        "a text highlight must never open the figure's card");
    assert.equal(registry.findByHighlight({ id: "temporary", text: "home MTSO", position: 4296, figure: {} }), figureCard);
}

// 5. 阅读模式：同一段里同样的字划了两次，第二个 <mark> 配第二个高亮
{
    const block = { tagName: "P", parentElement: null };
    const mark = text => ({
        tagName: "MARK", parentElement: block,
        cloneNode: () => ({ querySelectorAll: () => [], textContent: text }),
    });
    const m1 = mark("tandem"), m2 = mark("tandem");
    const root = { tagName: "DIV", parentElement: null, querySelectorAll: () => [m1, m2] };
    block.parentElement = root;
    const context = { getSectionInfo: el => el === block ? { lineStart: 3, lineEnd: 3 } : null };
    const highlights = [
        { id: "first", text: "tandem", position: 10, line: 3 },
        { id: "second", text: "tandem", position: 60, line: 3 },
        { id: "elsewhere", text: "tandem", position: 900, line: 20 },
    ];
    const resolver = new PreviewHighlightResolver(repoWith([]));
    assert.equal(resolver.findMatchingHighlight("tandem", m1, root, context, highlights)?.id, "first");
    assert.equal(resolver.findMatchingHighlight("tandem", m2, root, context, highlights)?.id, "second");
    // 说不出在哪几行（比如批注里的 ==tandem==）：全篇不止一个，就不配
    const noLines = { getSectionInfo: () => null };
    assert.equal(resolver.findMatchingHighlight("tandem", m1, root, noLines, highlights), null);
}

// 6. 改批注时点了别处：输入框关掉，批注正文和日期要放回去，不能只剩「展开」按钮
{
    let replacedWith = null;
    const contentEl = { name: "content" };
    const textarea = { isConnected: true, parentElement: {}, replaceWith: el => { replacedWith = el; textarea.isConnected = false; }, remove() {} };
    const footerClasses = new Set(["hi-note-hidden"]);
    const footer = { removeClass: c => footerClasses.delete(c) };
    const commentEl = { isConnected: true, removeClass() {} };
    removeCommentInputElements({ card: {}, textarea, commentEl }, false, { contentEl, footer });
    assert.equal(replacedWith, contentEl, "the comment text must come back");
    assert.ok(!footerClasses.has("hi-note-hidden"), "the date line must come back");
}

console.log("same words elsewhere: ok");
