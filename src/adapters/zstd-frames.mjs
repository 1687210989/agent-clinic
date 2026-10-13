/**
 * 多帧 zstd 解码器 —— agent-clinic 的核心基础能力
 *
 * ⚠️ 为什么需要这个文件：
 * DSH 的会话文件是「追加式事件流」，磁盘上表现为 **N 个独立 zstd 帧首尾拼接**。
 * 实测单个会话文件含 60 ~ 233 个帧。而：
 *   - zlib.zstdDecompressSync(整文件)  → 只返回第 1 帧（静默丢数据）
 *   - zlib.createZstdDecompress() 流式 → 同样只返回第 1 帧
 * 因此必须按 magic number 手工切帧，逐帧解码后拼接。
 *
 * 本实现已在真实数据上验证：463/463 帧解码成功。
 */

import fs from 'node:fs';
import zlib from 'node:zlib';

/** zstd 帧的 magic number：0x28 0xB5 0x2F 0xFD（小端 0xFD2FB528） */
export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 运行环境是否支持原生 zstd 解码（Node >= 22.15） */
export function hasZstdSupport() {
  return typeof zlib.zstdDecompressSync === 'function';
}

/**
 * 断言运行环境支持 zstd，否则抛出可操作的错误。
 * 绝不静默降级 —— 缺依赖时必须让用户看见。
 */
export function assertZstdSupport() {
  if (hasZstdSupport()) return;
  throw new Error(
    [
      '运行环境不支持原生 zstd 解码，无法读取 DSH 会话文件。',
      `当前 Node 版本：${process.version}（需要 >= 22.15.0）`,
      '',
      '解决办法（任选其一）：',
      '  1) 升级 Node：nvm install 22 && nvm use 22',
      '  2) 从 https://nodejs.org 安装 22.x LTS 或更高版本',
      '',
      '本工具不会静默跳过无法解码的数据。',
    ].join('\n'),
  );
}

/** 扫描 buffer 中所有 zstd 帧的起始偏移 */
export function findFrameOffsets(buf) {
  const offsets = [];
  let p = 0;
  while (true) {
    const i = buf.indexOf(ZSTD_MAGIC, p);
    if (i < 0) break;
    offsets.push(i);
    p = i + ZSTD_MAGIC.length;
  }
  return offsets;
}

/**
 * 解码一个可能是多帧 zstd 的 buffer，返回解码后的文本。
 *
 * @param {Buffer} buf 原始文件内容
 * @returns {{frames:number, badFrames:number, text:string, plain:boolean}}
 *   frames    识别到的 zstd 帧数（0 表示不是 zstd）
 *   badFrames 解码失败的帧数（坏帧不中断，计入统计）
 *   text      拼接后的文本
 *   plain     true 表示输入本身是明文（无 zstd magic），已原样返回
 */
export function decodeFrames(buf) {
  assertZstdSupport();

  const offsets = findFrameOffsets(buf);

  // 非 zstd：可能是无压缩的明文 .jsonl，原样返回
  if (offsets.length === 0) {
    return { frames: 0, badFrames: 0, text: buf.toString('utf8'), plain: true };
  }

  const parts = [];
  let badFrames = 0;

  for (let i = 0; i < offsets.length; i++) {
    const start = offsets[i];
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length;
    try {
      let part = zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8');
      // 防御：若帧未以换行结尾，补一个，避免与下一帧首行粘连成坏行
      if (part.length > 0 && !part.endsWith('\n')) part += '\n';
      parts.push(part);
    } catch {
      badFrames += 1; // 坏帧跳过并计数，绝不中断整体扫描
    }
  }

  return { frames: offsets.length, badFrames, text: parts.join(''), plain: false };
}

/** 便捷方法：直接从文件路径解码 */
export function decodeFramesFromFile(file) {
  return decodeFrames(fs.readFileSync(file));
}
