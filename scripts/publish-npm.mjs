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
 *   node scripts/publish-npm.mjs --tag next      # 指定 dist-tag（默认 next，即预发布通道）
 *   node scripts/publish-npm.mjs --out dist      # tarball 落盘目录（默认 dist/）
 *   node scripts/publish-npm.mjs --otp 123456    # 账号开了 2FA 时补一次性验证码
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
  if (res.status === 200 || res.status === 201) {
    process.stdout.write(`✅ 已发布 ${pkg.name}@${pkg.version}（dist-tag：${args.tag}）\n`);
    process.stdout.write(`   https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}\n`);
    return 0;
  }
  if (res.status === 409) {
    process.stderr.write(`❌ 该版本已存在（409）：${pkg.name}@${pkg.version} —— 改版本号后重试，不自动覆盖。\n`);
    return 1;
  }
  process.stderr.write(`❌ 发布失败：HTTP ${res.status}\n${text.slice(0, 800)}\n`);
  return 1;
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
