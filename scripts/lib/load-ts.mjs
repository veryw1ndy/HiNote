// 测试用：把一个 src 里的 .ts 文件打包成可以直接 import 的模块。
// obsidian 换成一个空壳，所以只能测不碰 Obsidian 运行时的那部分逻辑。
import esbuild from "esbuild";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// TFile 用 Symbol.hasInstance：测试里传的是 {path, basename, extension} 这样的假文件，
// 真正的 TFile 构造不出来，而被测代码到处在写 file instanceof TFile。
const OBSIDIAN_STUB = `
export class App {}
export class TFile {
    static [Symbol.hasInstance](value) {
        return !!value && typeof value === 'object' &&
            typeof value.path === 'string' && typeof value.extension === 'string';
    }
}
export class TFolder {} export class Notice {}
export class MarkdownView {} export class Menu {} export class Modal {} export class Component {}
export class Plugin {} export class FileSystemAdapter {} export class WorkspaceLeaf {}
export const setIcon = () => {}; export const normalizePath = (s) => s; export const getLinkpath = (s) => s;
export const debounce = (f) => f;
export const moment = Object.assign(() => ({}), { locale: () => 'en' });
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
