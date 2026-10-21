// 回归测试：一个公式在笔记里出现好几次时，高亮在哪一份上（src/math/mathSource.ts）。
// 运行：node scripts/test-math-source.mjs
//
// 当时的问题（2026-10-19，Types 05）：§3.2 表里 bool 那行的 ∀α. α → α → α 上的批注，
// 在 §2.1 表里同一个公式上也出现了。同一公式的每一份指纹都一样，而阅读模式存的是第一份的位置。
import { loadTs } from "./lib/load-ts.mjs";

const { MathSource: S } = await loadTs("src/math/mathSource.ts");

let fails = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log((ok ? "  ok   " : "  FAIL ") + name + (ok ? "" : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`));
};

// the shape of note 05: the formula in a §2.1 table, a callout, and the §3.2 table
const F = String.raw`$\forall\alpha.\,\alpha \to \alpha \to \alpha$`;
const src = [
  "## 2.1 What System F is",
  "",
  "| type function | pass it `[ℕ]` and you get | its type |",
  "| --- | --- | --- |",
  String.raw`| $\Lambda\alpha.\,\lambda x{:}\alpha.\,x$ | $\lambda x{:}\mathbb{N}.\,x$ | $\forall\alpha.\,\alpha \to \alpha$ |`,
  String.raw`| $\Lambda\alpha.\,\lambda x{:}\alpha.\,\lambda y{:}\alpha.\,x$ (keeps the first of two) | $\lambda x{:}\mathbb{N}.\,\lambda y{:}\mathbb{N}.\,x$ | ${F} |`,
  "",
  "> [!note] Aside",
  `> | a | ${F} |`,
  "> | --- | --- |",
  `> | b \\| c | x ${F} y ${F} |`,
  "",
  "### 3.2 The standard encodings",
  "",
  "| Type | Encoding | Constructors |",
  "| ---- | -------- | ------------ |",
  String.raw`| $1$  | $\forall\alpha.\,\alpha \to \alpha$ | $\langle\rangle$ |`,
  "| $0$  | $\\forall\\alpha.\\,\\alpha$ | none |",
  `| bool | ${F} | $\\textsf{true}$ |`,
  "",
].join("\n");

const occ = S.occurrences(src, F);
eq("five copies of the formula", occ.length, 5);
const [inTable21, inCalloutHead, inCallout1, inCallout2, inBool] = occ.map((o) => o.position);
const lineOf = (p) => occ.find((o) => o.position === p).line;
const block = (first, last) => {
  const lines = src.split("\n");
  const off = (n) => lines.slice(0, n).join("\n").length + (n ? 1 : 0);
  return { from: off(first), to: off(last) + lines[last].length };
};

// placing a rendered formula: block, table, row, cell
eq("bool row, §3.2 table", S.place(src, F, { ...block(14, 18), table: 0, row: 3, col: 1, nth: 0, nthInCell: 0 }), inBool);
eq("§2.1 table, row 2, column 3", S.place(src, F, { ...block(2, 5), table: 0, row: 2, col: 2, nth: 0, nthInCell: 0 }), inTable21);
eq("callout table header row", S.place(src, F, { ...block(7, 10), table: 0, row: 0, col: 1, nth: 0, nthInCell: 0 }), inCalloutHead);
eq("callout: escaped \\| does not split the cell; 2nd copy in the cell",
  S.place(src, F, { ...block(7, 10), table: 0, row: 1, col: 1, nth: 2, nthInCell: 1 }), inCallout2);
eq("no table info: nth copy in the block", S.place(src, F, { ...block(7, 10), nth: 1 }), inCallout1);
eq("the formula is not in that cell: null", S.place(src, F, { ...block(14, 18), table: 0, row: 1, col: 1, nth: 5, nthInCell: 0 }), null);

// resolving a saved highlight to a copy
const hl = (position, line, lineNth) => ({ position, figure: { kind: "math", tex: F, line, lineNth } });
eq("saved on the bool row: the bool row", S.resolve(src, hl(inBool, lineOf(inBool), 0)), inBool);
eq("bool row, position stale by 3000 characters", S.resolve(src, hl(inBool - 3000, lineOf(inBool), 0)), inBool);
eq("the bool row was edited: still the bool row",
  S.resolve(src.replace("| bool |", "| bool (true or false) |"), hl(inTable21, lineOf(inBool), 0)),
  S.occurrences(src.replace("| bool |", "| bool (true or false) |"), F)[4].position);
eq("two copies on one line: the second one", S.resolve(src, hl(inCallout1, lineOf(inCallout2), 1)), inCallout2);
eq("old highlight with no line: the nearest copy", S.resolve(src, { position: inBool - 4, figure: { kind: "math", tex: F } }), inBool);
eq("no tex: cannot say", S.resolve(src, { position: 5, figure: { kind: "math" } }), null);
eq("code spans are not formulas", S.occurrences("`" + F + "` " + F, F).length, 1);

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
