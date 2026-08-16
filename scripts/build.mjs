// dsh-taskboard-plugin 构建脚本（T5.1/T6.1 预搭）。
// Host 半边：esbuild bundle ESM → dist/host.js（peers external）。
// Client 半边：esbuild bundle CJS → 包装为 window.__ModuleLoader__.load({ id, factory })（in-box 实证格式，
//   docs/dsh-inbox-reference.md §1/§6：factory(require) 内 var module={exports:{}} … return module.exports）。
// 注：契约 C7 建议对齐 in-box 共享 tsdown 预设，但该预设不随包分发、不可安装；
//   本脚本以 esbuild 达成同一输出契约（peers external + ModuleLoader 包装 + sourcemap），
//   偏差将在 T5.1 验收时复核并按需记 ADR。
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(new URL(".", import.meta.url)));

/** 运行时由 DSH shell 提供的依赖，一律不打进 bundle（C7/ADR-6）。 */
const external = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/*",
  "@deepseek-ai/*",
];

async function buildHost() {
  await build({
    entryPoints: [path.join(root, "src/host.ts")],
    outfile: path.join(root, "dist/host.js"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22.5",
    external,
    sourcemap: true,
    logLevel: "info",
  });
}

async function buildClient() {
  const result = await build({
    entryPoints: [path.join(root, "src/client/index.ts")],
    bundle: true,
    format: "cjs",
    platform: "browser",
    target: "es2022",
    external,
    sourcemap: false, // 外层另生成；esbuild cjs sourcemap 注释在包装内不可用
    write: false,
    logLevel: "info",
  });
  const cjs = result.outputFiles[0].text;
  const wrapped = `window.__ModuleLoader__.load({\n\tid: "dsh-taskboard-plugin",\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n${cjs
    .split("\n")
    .map((l) => "\t\t" + l)
    .join("\n")}\n\t\treturn module.exports;\n\t}\n});\n`;
  await mkdir(path.join(root, "lib"), { recursive: true });
  await writeFile(path.join(root, "lib/client.js"), wrapped, "utf8");
}

await buildHost();
await buildClient();
console.log("dsh-taskboard-plugin build complete: dist/host.js + lib/client.js");
