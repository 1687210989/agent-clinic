#!/usr/bin/env node
/**
 * asar 内容抽取工具
 *
 * 用途：从 DSH 桌面应用的 app.asar 中读取任意文件，用于查阅官方包的
 * 文档与类型定义（开发 DSH 插件时的参考资料）。
 *
 * asar 格式（实测确认）：
 *   offset 0-3   : uint32 = 4
 *   offset 4-7   : uint32 = headerPickleSize
 *   offset 8-11  : uint32 = headerPickleSize - 4
 *   offset 12-15 : uint32 = JSON 长度
 *   offset 16    : JSON 头部
 *   数据区起点    : 8 + headerPickleSize
 *   文件内容      : 数据区起点 + node.offset
 *
 * 用法：
 *   node scripts/asar-extract.mjs <asar路径> <内部路径> [--list <前缀>]
 *
 * 示例：
 *   node scripts/asar-extract.mjs "D:/dsh/resources/app.asar" "/dsh/package.json"
 *   node scripts/asar-extract.mjs "D:/dsh/resources/app.asar" --list /dsh/node_modules/@deepseek-ai/dsh-client-ui-slots
 */

import fs from 'node:fs';

const asarPath = process.argv[2];
const target = process.argv[3];

if (!asarPath || !target) {
  console.error('用法: node asar-extract.mjs <asar路径> <内部路径|--list 前缀>');
  process.exit(1);
}

const fd = fs.openSync(asarPath, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);

const jsonLen = head.readUInt32LE(12);
const dataOffset = 8 + head.readUInt32LE(4);

const headerBuf = Buffer.alloc(jsonLen);
fs.readSync(fd, headerBuf, 0, jsonLen, 16);
const tree = JSON.parse(headerBuf.toString('utf8'));

function getNode(path) {
  let cur = tree;
  for (const part of path.split('/')) {
    if (!part) continue;
    cur = (cur.files || {})[part];
    if (!cur) return null;
  }
  return cur;
}

function* walk(node, prefix) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const p = `${prefix}/${name}`;
    if (child.files) yield* walk(child, p);
    else yield [p, child];
  }
}

if (target === '--list') {
  const prefix = (process.argv[4] ?? '/').replace(/^\/+/, '');
  const all = [...walk(tree, '')];
  const hits = all.filter(([p]) => p.replace(/^\/+/, '').startsWith(prefix));
  console.log(`共 ${all.length} 个文件，匹配前缀 "${prefix}" 的 ${hits.length} 个：`);
  for (const [p, n] of hits) {
    console.log(`  ${String(n.size).padStart(9)}  ${p}`);
  }
  process.exit(0);
}

const node = getNode(target);
if (!node) {
  console.error(`未找到：${target}`);
  process.exit(1);
}
if (node.files) {
  console.error(`这是目录，不是文件。用 --list 查看内容。`);
  process.exit(1);
}

const buf = Buffer.alloc(Number(node.size));
fs.readSync(fd, buf, 0, buf.length, dataOffset + Number(node.offset));
process.stdout.write(buf.toString('utf8'));
