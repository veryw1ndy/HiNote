// 把这个 fork 编译好装进一个库：npm run install-vault -- <库的路径>
//
// 库里 .obsidian/plugins/hi-note/ 只放编译出来的东西，改插件只改这个仓库，再跑这个脚本。
// 装进去的同时写一份 fork-build.json，记着是哪个提交编出来的。
// 工作区有没提交的改动时不装（加 --dirty 才装），免得库里跑的代码在哪儿都找不到。
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const allowDirty = args.includes("--dirty");
const vault = args.find(a => !a.startsWith("--"));
if (!vault) {
    console.error("usage: npm run install-vault -- <path to vault> [--dirty]");
    process.exit(2);
}
const vaultDir = resolve(vault);
if (!existsSync(join(vaultDir, ".obsidian"))) {
    console.error(`${vaultDir} is not an Obsidian vault (no .obsidian folder)`);
    process.exit(2);
}

const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trimEnd();
const dirty = git("status", "--porcelain", "--untracked-files=no");
if (dirty && !allowDirty) {
    console.error("The fork has uncommitted changes. Commit them first (or pass --dirty to install anyway):\n" + dirty);
    process.exit(1);
}

execFileSync("npm", ["run", "build"], { stdio: "inherit" });

const target = join(vaultDir, ".obsidian", "plugins", "hi-note");
mkdirSync(target, { recursive: true });
const files = ["main.js", "manifest.json", "styles.css"];
// 截图认字的小程序只在 Mac 上编得出来（npm run build:ocr），有就一起装
if (existsSync("hinote-ocr")) files.push("hinote-ocr");
for (const f of files) copyFileSync(f, join(target, f));

const commit = git("rev-parse", "HEAD");
const build = {
    repo: "https://github.com/veryw1ndy/HiNote",
    commit,
    subject: git("log", "-1", "--format=%s"),
    dirty: !!dirty,
    builtAt: new Date().toISOString()
};
writeFileSync(join(target, "fork-build.json"), JSON.stringify(build, null, 2) + "\n");

console.log(`\ninstalled ${files.join(", ")} from ${commit.slice(0, 7)}${dirty ? " (+ uncommitted changes)" : ""} into ${target}`);
console.log("In Obsidian: Cmd-P -> Reload HiNote.");
