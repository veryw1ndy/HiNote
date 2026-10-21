// 测试用：把一个 src 里的 .ts 文件打包成可以直接 import 的模块。
// obsidian 换成一个空壳，所以只能测不碰 Obsidian 运行时的那部分逻辑。
import esbuild from "esbuild";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const OBSIDIAN_STUB = `
export class App {} export class TFile {} export class TFolder {} export class Notice {}
export class MarkdownView {} export class Menu {} export class Modal {} export class Component {}
export class Plugin {} export class FileSystemAdapter {} export class WorkspaceLeaf {}
export const setIcon = () => {}; export const normalizePath = (s) => s; export const getLinkpath = (s) => s;
export const debounce = (f) => f; export const moment = () => ({});
`;

export async function loadTs(entry) {
    const result = await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        write: false,
        format: "esm",
        platform: "node",
        logLevel: "silent",
        plugins: [{
            name: "obsidian-stub",
            setup(build) {
                build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
                build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: OBSIDIAN_STUB, loader: "js" }));
            },
        }],
    });
    const out = join(mkdtempSync(join(tmpdir(), "hinote-test-")), "bundle.mjs");
    writeFileSync(out, result.outputFiles[0].text);
    return import(pathToFileURL(out).href);
}
