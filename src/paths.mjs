/**
 * paths.mjs — 凭据文件的路径解析
 *
 * 为什么需要单独一层：MCP 客户端（Claude Desktop / Cursor / OpenCode …）会用
 * **它自己的项目目录**作为子进程 cwd 来拉起 server.mjs。如果 secrets/ 只按 cwd 找，
 * 用户把凭据放在包目录里就会一直显示「文件不存在」。
 *
 * 解析优先级：
 *   1. 显式参数（工具入参 file 等）
 *   2. 环境变量（BILI_COOKIE_FILE / BILI_CRED_FILE）
 *   3. 已存在的 secrets/<name>：先包目录，再 cwd
 *   4. 都不存在 → 包目录 secrets/<name>
 *      （写入位置固定，不受启动方 cwd 影响）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 包根目录（src/ 的上一级），与 cwd 无关 */
export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 包目录与 cwd 下的候选位置，包目录在前 */
export function secretCandidates(name) {
  return [path.join(PKG_ROOT, "secrets", name), path.join(process.cwd(), "secrets", name)];
}

export function resolveSecretPath(explicit, envValue, name) {
  if (explicit) return explicit;
  if (envValue) return envValue;
  const cands = secretCandidates(name);
  for (const c of cands) if (fs.existsSync(c)) return c;
  return cands[0];
}
