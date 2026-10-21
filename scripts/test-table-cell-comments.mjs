// 回归测试：表格里两个一样的格子不能共用一条批注（2026-10-15，Types 02 的 intro/elim 表）。
// 运行：node scripts/test-table-cell-comments.mjs
import assert from "node:assert/strict";
import { loadTs } from "./lib/load-ts.mjs";

const { HighlightExtractor } = await loadTs("src/services/highlight/HighlightExtractor.ts");
const { findStoredHighlightMatch } = await loadTs("src/services/highlight/HighlightMatchStrategies.ts");

// 1. 一行里两个 ==\\== 只隔几个字：两个都要提取出来
const note = "| rule | intro | elim |\n| --- | --- | --- |\n| and | ==\\\\== | ==\\\\== |\n";
const extractor = new HighlightExtractor({ metadataCache: { getFileCache: () => null } }, () => undefined);
const found = extractor.extractHighlights(note, { path: "t.md", basename: "t", extension: "md" });
assert.equal(found.length, 2, "both identical cells should be extracted");
assert.notEqual(found[0].position, found[1].position);

// 2. 存了两份一样的文字、离得都近：按位置选不出来，不能随便配给最近的那份
const stored = [
    { id: "a", text: "\\\\", position: 52, comments: [{ id: "c", content: "intro" }] },
    { id: "b", text: "\\\\", position: 63, comments: [] },
];
const shifted = { id: "new", text: "\\\\", position: 60 };
const m = findStoredHighlightMatch(shifted, stored);
assert.ok(!m || m.confidence !== "text-position", "an ambiguous text-position match must not be taken");

// 3. 只有一份时照常按位置配上
const single = findStoredHighlightMatch({ id: "x", text: "only", position: 110 }, [{ id: "s", text: "only", position: 100 }]);
assert.equal(single?.highlight.id, "s");

console.log("table-cell comments: ok");
