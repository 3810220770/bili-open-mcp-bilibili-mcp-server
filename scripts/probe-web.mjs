#!/usr/bin/env node
/**
 * 主站 Web 隐藏能力的「可复现核验」。
 *
 * data/web.json 里每条都带一个 status（公开可调 / 需 Cookie / 有风控 / …）与一句 probe 记录。
 * 这个脚本按每条声明的参数**自动装配一个最小合法请求**，在无 Cookie、无签名的条件下重新打一遍，
 * 核对状态是否还对得上 —— 确认这份目录不是拍脑袋写的，也没随官方改版悄悄失效。
 *
 * 用法：
 *   npm run web:probe                     全部核验（默认 400ms 间隔）
 *   npm run web:probe -- --only report     只核验某一组（组 id 或组名）
 *   npm run web:probe -- --json            机器可读输出
 *
 * POST / 规则 / WebSocket 类条目一律不静默调用，直接跳过并标注。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "..");
const DATA = path.join(PKG, "data");

const argv = process.argv.slice(2);
const argOf = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const ONLY = argOf("--only", null);
const AS_JSON = argv.includes("--json");
const DELAY = Number(argOf("--delay", 400));

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const HEADERS = { "User-Agent": UA, Referer: "https://www.bilibili.com/" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** status → 无凭据时的预期返回 */
const EXPECT = {
  ok: { codes: [0], note: "code 0 公开可调" },
  "need-cookie": { codes: [-101], note: "-101 账号未登录" },
  risk: { codes: [-352, -403, -799, -101], note: "-352/-403/-799 风控（HTTP 412 也算命中）" },
  wbi: { codes: [0, -403, -352], note: "无签名时通或 -403" },
  priv: { codes: [53013, -400, 0], note: "53013 隐私未公开" },
  binary: { http: [200], note: "HTTP 200 二进制 / XML（非 JSON）" },
  gone: { http: [404], note: "HTTP 404 已下线" },
};

/** 按参数名给一个能跑通的最小值 */
const SAMPLE = {
  mid: 2, vmid: 2, up_mid: 2, host_mid: 2, fid: 2, uid: 1, ruid: 1, oid: 170001, aid: 170001,
  bvid: "BV1GJ411x7h7", cid: 28910202, rid: 1, room_id: 1, roomid: 1, roomId: 1, room_ids: "1",
  id: 1, tagid: 0, media_id: 0, rpid: 1, type: 1, pn: 1, ps: 5, page: 1, pageSize: 5, limit: 5,
  page_size: 5, keyword: "测试", term: "bili", qrcode_key: "test", search_type: "video",
  business: "reply", req_biz: "web", platform: "web", day: 3, follow_status: 0, status: "",
  protocol: "0,1", format: "0,1,2", codec: "0,1", qn: 10000, fnval: 16, ptype: 8, dolby: 5,
  panorama: 1, fourk: 1, mode: 3, sort: 2, order: "totalrank", need_sys_area: 1,
  parent_area_id: 1, area_id: 0, sort_type: "online",
  segment_index: 1, date: "2024-01-01", talker_id: 1, session_type: 1, size: 20,
  season_id: 1, page_num: 1, page_size: 10, sort_reverse: "false", series_id: 1, index: 1,
  ep_id: 1, fnver: 0, target_id: 1, unread_type: 0, show_dm: 1, group_fold: 1, unfollow_fold: 0,
  sort_rule: 2, build: 0, mobi_app: "web", only_normal: "true", count: 10,
};

function buildUrl(item) {
  if (item.probeQuery) return item.url + "?" + item.probeQuery;
  const qs = [];
  for (const p of item.params || []) {
    if (p.in !== "query") continue;
    if (["w_rid", "wts", "csrf", "csrf_token"].includes(p.name)) continue;
    const v = SAMPLE[p.name];
    if (v === undefined) continue;
    qs.push(encodeURIComponent(p.name) + "=" + encodeURIComponent(String(v)));
  }
  return item.url + (qs.length ? "?" + qs.join("&") : "");
}

async function probeOne(item) {
  if (item.method !== "GET") return { skipped: "非 GET（写操作 / 规则 / 长连），不静默调用" };
  const exp = EXPECT[item.status];
  if (!exp) return { skipped: "无可核验状态" };
  const url = buildUrl(item);
  try {
    const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(12000) });
    const txt = await r.text();
    let code = null;
    try {
      code = JSON.parse(txt).code;
    } catch {
      code = null;
    }
    // 条目可以用 expectCodes 覆盖「该接口自己会返回什么」，例如 reply-reply 正常就是 12006
    const codes = item.expectCodes || exp.codes;
    const ok = exp.http
      ? exp.http.includes(r.status)
      : (r.status === 200 && codes.includes(code)) ||
        // HTTP 412 是风控页：接口确实在，只是这把没让过 —— 对非「已下线」条目算命中
        (r.status === 412 && item.status !== "gone");
    return { http: r.status, code, ok, expect: item.expectCodes ? `code ∈ {${codes.join(",")}}` : exp.note, url };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 80), expect: exp.note, url };
  }
}

const web = JSON.parse(fs.readFileSync(path.join(DATA, "web.json"), "utf8"));

const rows = [];
for (const g of web.groups) {
  if (ONLY && g.id !== ONLY && g.name !== ONLY) continue;
  for (const item of g.items) rows.push({ group: g.name, item });
}

if (!AS_JSON) console.log(`探测 ${rows.length} 条（无 Cookie / 无签名，间隔 ${DELAY}ms）……\n`);

const results = [];
for (const { group, item } of rows) {
  const r = await probeOne(item);
  results.push({ group, id: item.id, name: item.name, status: item.status, ...r });
  if (!AS_JSON) {
    const tag = r.skipped ? "跳过" : r.ok ? "通过" : "变化";
    const detail = r.skipped
      ? r.skipped
      : r.error
        ? r.error
        : `HTTP ${r.http} code ${r.code}（预期 ${r.expect}）`;
    console.log(`[${tag}] ${item.id.padEnd(24)} ${item.status.padEnd(12)} ${detail}`);
  }
  await sleep(DELAY);
}

const live = results.filter((r) => !r.skipped);
const pass = live.filter((r) => r.ok).length;
const changed = live.filter((r) => !r.ok);
const skipped = results.length - live.length;

if (AS_JSON) {
  console.log(JSON.stringify({ total: results.length, checked: live.length, passed: pass, skipped, changed, results }, null, 1));
} else {
  console.log(
    `\n核验完成：实打 ${live.length} 条，通过 ${pass}，与记录不符 ${changed.length}，跳过 ${skipped}（写操作 / 规则）`
  );
  if (changed.length) {
    console.log("\n与 data/web.json 记录不符（官方可能改版，复核后更新 status / probe）：");
    for (const c of changed) console.log(`  · ${c.id}（${c.group}） ${c.error || `HTTP ${c.http} code ${c.code}`}`);
  }
}

// 官方接口随时可能变；探测波动不当作构建失败。
process.exitCode = 0;
