#!/usr/bin/env node
/**
 * 零依赖 npm 发布通道
 *
 * 为什么需要它：本机（以及本项目的 CI 容器之外的一些环境）**没有 npm CLI** ——
 * `npm` / `npm.cmd` / `corepack` / `npm-cli.js` 全都不存在，也没有 `~/.npmrc`。
 * 但"发布"这件事本身并不需要 npm：registry 的发布协议就是
 *
 *   PUT https://registry.npmjs.org/<name>
 *   Authorization: Bearer <token>
 *   { _id, name, dist-tags, versions: { <v>: {...manifest, dist} },
 *     _attachments: { "<name>-<v>.tgz": { data: <base64 tarball> } } }
 *
 * 所以本脚本自己做三件事：**按 package.json 的 files 白名单打包（tar+gzip）**、
 * **自校验（解包回来后逐字节比对）**、**PUT 上传**。
 *
 * 用法：
 *   node scripts/publish-npm.mjs                 # 预演（默认）：打包 + 自校验 + 打印将要发送的请求
 *   node scripts/publish-npm.mjs --publish       # 真正发布（需要 NPM_TOKEN 或 ~/.npmrc）
 *   node scripts/publish-npm.mjs --verify        # 发布后自证：去 registry 核对 dist-tag / integrity / 逐字节
 *   node scripts/publish-npm.mjs --tag next      # 指定 dist-tag（默认 next，即预发布通道）
 *   node scripts/publish-npm.mjs --out dist      # tarball 落盘目录（默认 dist/）
 *   node scripts/publish-npm.mjs --otp 123456    # 账号开了 2FA 时补一次性验证码
 *
 * 关于 2FA 与"分阶段发布"（staged publish）：若账号开了 2FA，
 * registry 可能返回 **202 = 已接受**，并先建一个占位版本 `0.0.0-stage`，
 * 正式版本在批准（或自动放行）后生效。这不是失败 —— 202 会被如实报成"已接受"，
 * 之后用 `--verify` 复核实际结果（本脚本第一次真实发布时就踩过这个坑：
 * 老版本把 202 打成"发布失败"，而 registry 其实已经接受了）。
 *
 * 纪律（与仓库其它部分一致）：
 *   1. 默认**不联网**（`--publish` 才发请求）；
 *   2. 打包后**必须**解包回来逐字节比对，任何不一致直接失败退出 —— 宁可发不出去，
 *      也不要发一个装不上的包；
 *   3. 版本已存在（HTTP 409）如实报错，不自动改版本号。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const get = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
  };
  return {
    publish: argv.includes('--publish'),
    verify: argv.includes('--verify'),
    tag: get('--tag', 'next'),
    outDir: get('--out', path.join(ROOT, 'dist')),
    otp: get('--otp', null),
    registry: get('--registry', 'https://registry.npmjs.org'),
  };
}

// ---------------------------------------------------------------------------
// tar 写入（ustar，够 npm registry 用）
// ---------------------------------------------------------------------------

const BLOCK = 512;

function octal(value, len) {
  // 7 位八进制 + NUL（ustar 的标准写法）
  return `${Number(value).toString(8).padStart(len - 1, '0')}\0`;
}

/**
 * 构造一个 ustar 头块。
 *
 * ⚠️ 路径超过 100 字节时必须拆进 `prefix` 字段（ustar 的 155 字节附加前缀），
 * 否则会被截断 —— 本项目的 `src/catalog/capabilities.mjs` 之类路径还没到，
 * 但 `scripts/fixtures/synth-dsh.mjs` 已接近，故这里正经实现。
 */
function tarHeader({ name, size, type = '0', mode = 0o644, mtime = 0 }) {
  const buf = Buffer.alloc(BLOCK, 0);
  let prefix = '';
  let base = name;
  if (Buffer.byteLength(base, 'utf8') + 1 > 100) {
    const cut = name.lastIndexOf('/', name.length - 100);
    if (cut < 0) throw new Error(`tar 路径过长且无法拆分：${name}`);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
    if (Buffer.byteLength(prefix, 'utf8') > 155) throw new Error(`tar 前缀过长：${prefix}`);
  }
  buf.write(base, 0, 100, 'utf8');
  buf.write(octal(mode, 8), 100, 8, 'utf8');
  buf.write(octal(0, 8), 108, 8, 'utf8'); // uid
  buf.write(octal(0, 8), 116, 8, 'utf8'); // gid
  buf.write(octal(size, 12), 124, 12, 'utf8');
  buf.write(octal(mtime, 12), 136, 12, 'utf8');
  buf.write('        ', 148, 8, 'utf8'); // chksum 先填空格
  buf.write(type, 156, 1, 'utf8');
  buf.write('ustar\0', 257, 6, 'utf8');
  buf.write('00', 263, 2, 'utf8');
  buf.write(prefix, 345, 155, 'utf8');

  let sum = 0;
  for (const b of buf) sum += b;
  // 校验和：6 位八进制 + NUL + 空格
  buf.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');
  return buf;
}

function tarAdd(entries, name, content, type = '0') {
  entries.push(tarHeader({ name, size: content.length, type }));
  if (type === '0') {
    entries.push(content);
    const pad = (BLOCK - (content.length % BLOCK)) % BLOCK;
    if (pad) entries.push(Buffer.alloc(pad, 0));
  }
}

/** @returns {Buffer} 完整的 tar（未 gzip） */
function tarPack(files) {
  const entries = [];
  // 目录条目先补齐（有些解包器对隐式目录不友好；npm 自己的包也带目录条目）
  const dirs = new Set();
  for (const f of files) {
    const parts = f.rel.split('/');
    parts.pop();
    let acc = 'package';
    for (const p of parts) {
      acc = `${acc}/${p}`;
      dirs.add(acc);
    }
  }
  for (const d of [...dirs].sort()) tarAdd(entries, `${d}/`, Buffer.alloc(0), '5');
  for (const f of files) tarAdd(entries, `package/${f.rel}`, f.content);
  entries.push(Buffer.alloc(BLOCK * 2, 0)); // 结束标记
  return Buffer.concat(entries);
}

/** 解包（自校验用）：只认普通文件，返回 name -> Buffer */
function tarUnpack(buf) {
  const out = new Map();
  let i = 0;
  while (i + BLOCK <= buf.length) {
    const head = buf.subarray(i, i + BLOCK);
    if (head.every((b) => b === 0)) break;
    const name = head.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const prefix = head.toString('utf8', 345, 500).replace(/\0.*$/, '');
    const size = parseInt(head.toString('utf8', 124, 136).replace(/\0.*$/, '').trim(), 8) || 0;
    const type = head.toString('utf8', 156, 157);
    const full = prefix ? `${prefix}/${name}` : name;
    i += BLOCK;
    const content = buf.subarray(i, i + size);
    i += Math.ceil(size / BLOCK) * BLOCK;
    if (type === '0') out.set(full, Buffer.from(content));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 收集要发布的文件（package.json 的 files 白名单）
// ---------------------------------------------------------------------------

function collectFiles(pkg) {
  const files = [];
  const seen = new Set();
  const add = (abs, rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    files.push({ rel, content: fs.readFileSync(abs) });
  };
  const walk = (abs, rel) => {
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) walk(path.join(abs, name), `${rel}/${name}`);
    } else {
      add(abs, rel);
    }
  };

  // 永远带上（npm 要求 package/package.json 必须在包里）
  for (const always of ['package.json', 'README.md', 'LICENSE']) {
    if (fs.existsSync(path.join(ROOT, always))) add(path.join(ROOT, always), always);
  }
  for (const entry of pkg.files ?? []) {
    const abs = path.join(ROOT, entry);
    if (!fs.existsSync(abs)) {
      throw new Error(`package.json 的 files 里列了不存在的路径：${entry}`);
    }
    walk(abs, entry);
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return files;
}

// ---------------------------------------------------------------------------
// 打包 + 自校验
// ---------------------------------------------------------------------------

function pack() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const files = collectFiles(pkg);
  const tar = tarPack(files);
  const tgz = zlib.gzipSync(tar, { level: 9 });

  // ---- 自校验：解包回来逐字节比对（宁可发不出去，也不要发一个装不上的包）----
  const back = tarUnpack(zlib.gunzipSync(tgz));
  for (const f of files) {
    const got = back.get(`package/${f.rel}`);
    if (!got) throw new Error(`自校验失败：包里没有 package/${f.rel}`);
    if (!got.equals(f.content)) throw new Error(`自校验失败：package/${f.rel} 内容不一致`);
  }
  for (const name of back.keys()) {
    if (!files.some((f) => `package/${f.rel}` === name)) throw new Error(`自校验失败：多出文件 ${name}`);
  }
  const backPkg = JSON.parse(back.get('package/package.json').toString('utf8'));
  if (backPkg.version !== pkg.version) throw new Error('自校验失败：包内版本与 package.json 不一致');

  const shasum = crypto.createHash('sha1').update(tgz).digest('hex');
  const integrity = `sha512-${crypto.createHash('sha512').update(tgz).digest('base64')}`;
  return { pkg, files, tgz, tar, shasum, integrity };
}

// ---------------------------------------------------------------------------
// 发布体
// ---------------------------------------------------------------------------

export function buildPublishBody({ pkg, tgz, shasum, integrity, tag, fileName }) {
  const version = pkg.version;
  const manifest = {
    ...pkg,
    _id: `${pkg.name}@${version}`,
    dist: {
      shasum,
      integrity,
      tarball: `https://registry.npmjs.org/${pkg.name}/-/${fileName}`,
    },
  };
  return {
    _id: pkg.name,
    name: pkg.name,
    description: pkg.description,
    'dist-tags': { [tag]: version },
    versions: { [version]: manifest },
    _attachments: {
      [fileName]: {
        content_type: 'application/octet-stream',
        data: tgz.toString('base64'),
        length: tgz.length,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 响应分类（这段是被真实发布打脸后加的）
// ---------------------------------------------------------------------------

/**
 * 把 registry 的发布响应翻译成"到底发生了什么"。
 *
 * ⚠️ 第一版只把 200/201 当成功，于是首次真实发布时脚本打印
 *    `❌ 发布失败：HTTP 202` —— 而 202 的真实含义是 **被接受**：
 *    npm 对带 2FA 的账号走"分阶段发布（staged publish）"，
 *    先建占位版本 `0.0.0-stage`，随后（自动或人工批准后）正式生效。
 *    结论：把 2xx 一律当"已接受"，再按 body / 409 文案细分下一步。
 *
 * @returns {{outcome:'published'|'staged'|'version-exists'|'stage-conflict'|'auth'|'failed', message:string}}
 */
export function classifyPublishResponse(status, bodyText = '') {
  const body = String(bodyText);
  if (status === 200 || status === 201) {
    return { outcome: 'published', message: '已发布（registry 直接接受）' };
  }
  if (status >= 200 && status < 300) {
    return {
      outcome: 'staged',
      message:
        'registry 已**接受**（HTTP ' +
        status +
        '）—— 账号开了 2FA 时会走 npm 的"分阶段发布"：' +
        '先出现占位版本 0.0.0-stage，待批准（或自动放行）后正式生效。' +
        '稍等片刻用 --verify 复核实际结果。',
    };
  }
  if (status === 409) {
    if (/previously staged version/.test(body)) {
      return { outcome: 'stage-conflict', message: '该版本已在审核区里（不能重复提交）—— 去 npm 网站或 npm stage list/approve 处理' };
    }
    if (/previously published version|Cannot publish over existing version|already exists/i.test(body)) {
      return { outcome: 'version-exists', message: '该版本已发布过 —— 改版本号后重试，不自动覆盖' };
    }
    return { outcome: 'failed', message: `HTTP 409：${body.slice(0, 200)}` };
  }
  if (status === 401 || status === 403) {
    return {
      outcome: 'auth',
      message: `凭据/权限不足（HTTP ${status}）${/EOTP|one-time pass/i.test(body) ? '：需要一次性验证码（--otp）' : ''}：${body.slice(0, 200)}`,
    };
  }
  return { outcome: 'failed', message: `HTTP ${status}：${body.slice(0, 200)}` };
}

// ---------------------------------------------------------------------------
// 发布后自证（--verify）：不信任"成功"两个字，去 registry 把包拉回来对一遍
// ---------------------------------------------------------------------------

export async function verifyPublished({ pkg, tgz, integrity, tag, registry }) {
  const url = `${registry}/${pkg.name}`;
  const res = await fetch(url, { headers: { 'user-agent': 'agent-clinic-publish/1.0' } });
  if (res.status !== 200) return { ok: false, detail: `packument HTTP ${res.status}` };
  const meta = await res.json();
  const tags = meta['dist-tags'] ?? {};
  const publishedVersion = tags[tag] ?? null;
  const versionMeta = meta.versions?.[pkg.version];
  if (!versionMeta) {
    return {
      ok: false,
      detail: `registry 里还没有 ${pkg.version}（当前 dist-tags：${JSON.stringify(tags)}）—— 若刚发布，稍等再试`,
    };
  }
  if (publishedVersion !== pkg.version) {
    return {
      ok: false,
      detail: `dist-tag ${tag} 指向 ${publishedVersion}，不是 ${pkg.version}`,
    };
  }
  if (integrity && versionMeta.dist?.integrity && versionMeta.dist.integrity !== integrity) {
    return {
      ok: false,
      detail:
        `本地打包与 registry 上已发布的内容**不一致**（integrity 不同）——` +
        `通常意味着"发布之后又改了工作区里的文件"。` +
        (tgz ? '下次发布请从已提交（最好已打 tag）的状态打包。' : ''),
    };
  }
  // 把 registry 上的 tarball 拉回来，逐字节核对本地那份
  const t = await fetch(versionMeta.dist.tarball, { headers: { 'user-agent': 'agent-clinic-publish/1.0' } });
  if (t.status !== 200) return { ok: false, detail: `tarball HTTP ${t.status}` };
  const remote = Buffer.from(await t.arrayBuffer());
  const same = tgz ? remote.equals(tgz) : true;
  return {
    ok: true,
    detail:
      `dist-tags.${tag} = ${publishedVersion} · tarball ${remote.length} 字节 · ` +
      (tgz ? (same ? '与本地打包逐字节一致' : '⚠ 与本地打包不一致（工作区可能在打包后被改过）') : '（未比对本地）'),
    fileCount: versionMeta.dist?.fileCount ?? null,
  };
}

// ---------------------------------------------------------------------------
// 凭据
// ---------------------------------------------------------------------------

/** 取 token：环境变量优先，其次 ~/.npmrc 的 `//registry...:_authToken=` */
export function readToken(argv = process.argv.slice(2), env = process.env) {
  if (env.NPM_TOKEN) return { token: env.NPM_TOKEN, from: '环境变量 NPM_TOKEN' };
  if (env.NODE_AUTH_TOKEN) return { token: env.NODE_AUTH_TOKEN, from: '环境变量 NODE_AUTH_TOKEN' };
  for (const p of [path.join(os.homedir(), '.npmrc'), path.join(ROOT, '.npmrc')]) {
    if (!fs.existsSync(p)) continue;
    const m = /_authToken\s*=\s*([^\s]+)/.exec(fs.readFileSync(p, 'utf8'));
    if (m) return { token: m[1], from: `${p} 的 _authToken` };
  }
  return { token: null, from: null };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { pkg, files, tgz, shasum, integrity } = pack();
  const fileName = `${pkg.name}-${pkg.version}.tgz`;

  fs.mkdirSync(args.outDir, { recursive: true });
  const outPath = path.join(args.outDir, fileName);
  fs.writeFileSync(outPath, tgz);

  process.stdout.write(`包名：${pkg.name} · 版本：${pkg.version} · dist-tag：${args.tag}\n`);
  process.stdout.write(`文件 ${files.length} 个 · tar ${(files.reduce((n, f) => n + f.content.length, 0) / 1024).toFixed(1)} KiB`);
  process.stdout.write(` · tgz ${(tgz.length / 1024).toFixed(1)} KiB\n`);
  process.stdout.write(`shasum：${shasum}\nintegrity：${integrity}\n`);
  process.stdout.write(`tarball：${outPath}\n`);
  process.stdout.write('自校验：解包回来逐字节比对 · package/package.json 版本一致 · 无多余文件 → 通过\n');

  const body = buildPublishBody({ pkg, tgz, shasum, integrity, tag: args.tag, fileName });
  const bodyText = JSON.stringify(body);

  if (args.verify) {
    // 发布后自证：去 registry 把包拉回来，核对 dist-tag / integrity / 逐字节
    process.stdout.write('\n正在向 registry 核对（只读）…\n');
    const v = await verifyPublished({
      pkg,
      tgz,
      integrity,
      tag: args.tag,
      registry: args.registry,
    });
    process.stdout.write(`${v.ok ? '✅' : '❌'} ${v.detail}\n`);
    if (v.ok) process.stdout.write(`   https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}\n`);
    return v.ok ? 0 : 1;
  }

  if (!args.publish) {
    process.stdout.write('\n（预演，未联网）将要发送：\n');
    process.stdout.write(`  PUT ${args.registry}/${pkg.name}\n`);
    process.stdout.write(`  Authorization: Bearer <token>${args.otp ? `  · npm-otp: ${args.otp}` : ''}\n`);
    process.stdout.write(`  Content-Type: application/json · body ${(bodyText.length / 1024).toFixed(1)} KiB`);
    process.stdout.write(`（含 base64 后的 tarball）\n`);
    const { token, from } = readToken();
    process.stdout.write(
      token
        ? `  凭据：已从 ${from} 读到\n`
        : '  凭据：**未找到**（需要 NPM_TOKEN 环境变量，或 ~/.npmrc 里的 _authToken）\n',
    );
    process.stdout.write('\n要真正发布：node scripts/publish-npm.mjs --publish\n');
    return 0;
  }

  const { token, from } = readToken();
  if (!token) {
    process.stderr.write('缺少凭据：请设置 NPM_TOKEN，或在 ~/.npmrc 写入 _authToken。\n');
    return 2;
  }
  process.stdout.write(`\n正在发布（凭据来自 ${from}）…\n`);

  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'user-agent': 'agent-clinic-publish/1.0 (zero-dep)',
  };
  if (args.otp) headers['npm-otp'] = String(args.otp);

  const res = await fetch(`${args.registry}/${pkg.name}`, { method: 'PUT', headers, body: bodyText });
  const text = await res.text();
  const verdict = classifyPublishResponse(res.status, text);
  if (verdict.outcome === 'published' || verdict.outcome === 'staged') {
    process.stdout.write(`✅ ${verdict.message}\n`);
    process.stdout.write(`   稍后自证：node scripts/publish-npm.mjs --verify --tag ${args.tag}\n`);
    return 0;
  }
  process.stderr.write(`❌ ${verdict.message}\n`);
  return verdict.outcome === 'version-exists' || verdict.outcome === 'stage-conflict' ? 1 : 1;
}

// 直接执行才跑（被 import 时只暴露函数，供自检做打包校验）
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = await main();
  } catch (e) {
    process.stderr.write(`❌ ${e.message}\n`);
    process.exitCode = 1;
  }
}

export { pack, tarPack, tarUnpack, collectFiles };