// dsh-taskboard-plugin vendored 应用同步脚本（发布改造 R1）。
// 从同级 ../taskboard 检出把应用子集镜像同步进包内 app/：
//   目录：server/ shared/ cli/ skills/ dist/web/   文件：LICENSE PRIVACY.md
// 镜像语义 = 先删目标再拷贝，源侧删除的文件不会残留；执行后对比同步前后快照打印差异，
// 并尽力回读 ../taskboard/.git 的 HEAD commit（纯 fs，不 spawn git）。
// 防御性排除：子集内出现 node_modules / .data / .git 时不带进包。
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(new URL(".", import.meta.url)));
const src = path.resolve(root, "..", "taskboard");
const app = path.join(root, "app");

/** 相对 src → 相对 app 同名映射的同步子集。 */
const DIR_SUBSETS = ["server", "shared", "cli", "skills", path.join("dist", "web")];
const FILE_SUBSETS = ["LICENSE", "PRIVACY.md"];
/** 目录/文件名级排除（快照与拷贝共用，保证两边口径一致）。 */
const EXCLUDE = new Set(["node_modules", ".data", ".git"]);

if (!(await stat(path.join(src, "server", "index.mjs"))).isFile()) {
  throw new Error(`taskboard source not found at ${src} (expected server/index.mjs)`);
}

/** 递归快照：Map<相对路径, sha1>，跳过 EXCLUDE 名。 */
async function snapshot(dir) {
  const files = new Map();
  async function walk(abs, rel) {
    for (const entry of await readdir(abs, { withFileTypes: true })) {
      if (EXCLUDE.has(entry.name)) continue;
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(childAbs, childRel);
      else if (entry.isFile()) {
        const buf = await readFile(childAbs);
        files.set(childRel, createHash("sha1").update(buf).digest("hex"));
      }
    }
  }
  await walk(dir, "");
  return files;
}

const before = await snapshot(app);

for (const rel of DIR_SUBSETS) {
  await rm(path.join(app, rel), { recursive: true, force: true });
  await mkdir(path.dirname(path.join(app, rel)), { recursive: true });
  await cp(path.join(src, rel), path.join(app, rel), {
    recursive: true,
    force: true,
    filter: (candidate) => !EXCLUDE.has(path.basename(candidate)),
  });
}
for (const rel of FILE_SUBSETS) {
  await mkdir(path.dirname(path.join(app, rel)), { recursive: true });
  await cp(path.join(src, rel), path.join(app, rel), { force: true });
}

const after = await snapshot(app);
const added = [...after.keys()].filter((f) => !before.has(f));
const removed = [...before.keys()].filter((f) => !after.has(f));
const changed = [...after.keys()].filter((f) => before.has(f) && before.get(f) !== after.get(f));

function list(names) {
  const shown = names.slice(0, 20).map((f) => `  ${f}`);
  return names.length > 20 ? [...shown, `  … +${names.length - 20} more`] : shown;
}
if (added.length) console.log(`added (${added.length}):\n${list(added).join("\n")}`);
if (removed.length) console.log(`removed (${removed.length}):\n${list(removed).join("\n")}`);
if (changed.length) console.log(`changed (${changed.length}):\n${list(changed).join("\n")}`);

let head = "unknown";
try {
  const gitHead = (await readFile(path.join(src, ".git", "HEAD"), "utf8")).trim();
  const ref = gitHead.startsWith("ref: ") ? gitHead.slice(5) : null;
  const rev = ref ? (await readFile(path.join(src, ".git", ref), "utf8")).trim() : gitHead;
  head = rev.slice(0, 12);
} catch {
  // 无 .git（如压缩包检出）时保持 unknown，不阻断同步。
}
console.log(`vendored ${after.size} files from ../taskboard@${head} — ${added.length} added, ${removed.length} removed, ${changed.length} changed`);
