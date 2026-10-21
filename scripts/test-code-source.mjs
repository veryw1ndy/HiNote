// 测试：代码块里的高亮落在哪儿（src/code/codeSource.ts）。
// 运行：node scripts/test-code-source.mjs
import { loadTs } from "./lib/load-ts.mjs";

const { CodeSource: S } = await loadTs("src/code/codeSource.ts");

let fails = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log((ok ? "  ok   " : "  FAIL ") + name + (ok ? "" : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`));
};

const src = [
  "# Notes",                     // 0
  "",                            // 1
  "```ocaml",                    // 2
  "let yes = s(z)",              // 3
  "let no = z",                  // 4
  "```",                         // 5
  "",                            // 6
  "> [!note] In a callout",      // 7
  "> ```python",                 // 8
  "> x = 1",                     // 9
  ">   y = 2",                   // 10
  "> ```",                       // 11
  "",                            // 12
  "- a list item",               // 13
  "  ```c",                      // 14
  "  int x;",                    // 15
  "    int y;",                  // 16
  "  ```",                       // 17
  "",                            // 18
  "````md",                      // 19
  "```",                         // 20
  "inner",                       // 21
  "````",                        // 22
  "",                            // 23
  "``not a fence``` x",          // 24
  "~~~",                         // 25
  "tilde",                       // 26
  "~~~",                         // 27
  "```ocaml",                    // 28
  "let yes = s(z)",              // 29
  "let no = z",                  // 30
  "```",                         // 31
].join("\n");

const blocks = S.blocks(src);
eq("finds every block", blocks.map(b => [b.line, b.lang]), [[2, "ocaml"], [8, "python"], [14, "c"], [19, "md"], [25, ""], [28, "ocaml"]]);
eq("code is what the page shows", blocks.map(b => b.code), [
  "let yes = s(z)\nlet no = z", "x = 1\n  y = 2", "int x;\n  int y;", "```\ninner", "tilde", "let yes = s(z)\nlet no = z",
]);
eq("same code, same fingerprint", blocks[0].sig === blocks[5].sig && blocks[0].sig !== blocks[1].sig, true);

// 代码里的字 ↔ 原文的字
const at = (b, from, to) => src.slice(S.toSrc(b, from), S.toSrc(b, to));
eq("toSrc in a plain block", at(blocks[0], 4, 7), "yes");
eq("toSrc across lines", at(blocks[0], 10, 18), "s(z)\nlet");
eq("toSrc skips the callout's >", at(blocks[1], 0, 5), "x = 1");
eq("toSrc second callout line", at(blocks[1], 8, 13), "y = 2");
eq("toSrc skips the list indent", at(blocks[2], 9, 15), "int y;");
const p = src.indexOf("y = 2");
eq("toCode back", S.toCode(blocks[1], p), 8);
eq("toCode on the fence is outside", S.toCode(blocks[0], src.indexOf("```ocaml")), null);
eq("at finds the block", S.at(blocks, src.indexOf("int y")), { block: 2, code: 9 });

// 找高亮
const hl = (b, from, to, extra = {}) => ({
  text: blocks[b].code.slice(from, to),
  position: S.toSrc(blocks[b], from),
  figure: { kind: "code", path: blocks[b].sig, label: blocks[b].lang, from: [from], to: [to] },
  ...extra,
});
eq("unchanged block", S.resolve(blocks, hl(0, 4, 7)), { block: 0, from: 4, to: 7 });
eq("same code twice: the copy it was made on", S.resolve(blocks, hl(5, 4, 7)), { block: 5, from: 4, to: 7 });

const above = S.blocks("intro paragraph added later\n\n" + src);
eq("text added above: still the same copy", S.resolve(above, hl(5, 4, 7)), { block: 5, from: 4, to: 7 });
const eb = S.blocks(src.replace("> x = 1", "> # setup\n> x = 1"));
eq("edited block: found again by its text", S.resolve(eb, hl(1, 8, 13)), { block: 1, from: 16, to: 21 });
eq("edited block: the others are untouched", S.resolve(eb, hl(0, 4, 7)), { block: 0, from: 4, to: 7 });
eq("text gone: nothing", S.resolve(S.blocks(src.replace(/yes/g, "oui")), hl(0, 4, 7)), null);
eq("only looks in the same language", S.resolve(blocks, { ...hl(1, 0, 1), figure: { ...hl(1, 0, 1).figure, path: "code:none", label: "c" } }), { block: 2, from: 4, to: 5 });
eq("not a code highlight", S.resolve(blocks, { text: "x", position: 0 }), null);

eq("unclosed block runs to the end", S.blocks("a\n```js\nlet x\nlet y").map(b => b.code), ["let x\nlet y"]);
eq("quote ends the block", S.blocks("> ```\n> a\nb").map(b => b.code), ["a"]);

if (fails) {
  console.log(`\n${fails} failed`);
  process.exit(1);
}
console.log("\nall passed");
