/**
 * credentials.mjs — 开放平台凭据（client_id / app_secret / access_token）
 *
 * 优先级：显式参数 → 环境变量 → 凭据文件（默认 secrets/open-platform.json，
 * 可用 BILI_CRED_FILE 覆盖）。文件不必存在；为空就是「没配置」。
 */
import fs from "node:fs";
import path from "node:path";

export function credPath(explicit) {
  return explicit || process.env.BILI_CRED_FILE || path.join(process.cwd(), "secrets", "open-platform.json");
}

export function loadCredFile(explicit) {
  const file = credPath(explicit);
  if (!fs.existsSync(file)) return { file, exists: false, data: {} };
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    return { file, exists: true, data: typeof data === "object" && data ? data : {} };
  } catch (e) {
    return { file, exists: true, data: {}, error: e.message };
  }
}

export function saveCredFile(patch, explicit) {
  const cur = loadCredFile(explicit);
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined && v !== null && v !== ""));
  const data = { ...cur.data, ...clean };
  fs.mkdirSync(path.dirname(cur.file), { recursive: true });
  fs.writeFileSync(cur.file, JSON.stringify(data, null, 1), "utf8");
  return { file: cur.file, data };
}

/** 每一格的来源，用于诊断「为什么没生效」 */
export function credStatus(explicit = {}) {
  const f = loadCredFile();
  const env = (k) => process.env[k] || "";
  const slot = (explicitName, keys, fileKey) => {
    if (explicit[explicitName]) return { set: true, from: "参数" };
    for (const k of keys) if (env(k)) return { set: true, from: `环境变量 ${k}` };
    if (f.data[fileKey]) return { set: true, from: `文件 ${fileKey}` };
    return { set: false, from: "—" };
  };
  return {
    file: f.file,
    fileExists: f.exists,
    fileError: f.error,
    clientId: slot("clientId", ["BILI_CLIENT_ID", "BILI_ACCESS_KEY_ID"], "clientId"),
    appSecret: slot("appSecret", ["BILI_APP_SECRET", "BILI_SECRET"], "appSecret"),
    accessToken: slot("accessToken", ["BILI_ACCESS_TOKEN", "BILI_TOKEN"], "accessToken"),
    refreshToken: f.data.refreshToken ? { set: true, from: "文件 refreshToken" } : { set: false, from: "—" },
    expiresIn: f.data.expires_in,
    scopes: f.data.scopes,
  };
}
