/**
 * 处方类型定义（纯常量 + 复用配置层的 YAML 渲染）
 *
 * 从 index.mjs 拆出来，是为了让 remedies.mjs 能引用类型而不产生循环依赖。
 */

export const REMEDY_KIND = {
  CONFIG: 'config',     // 改 profile 的一行配置（给出 YAML 片段）
  COMMAND: 'command',   // 直接跑的斜杠命令 / shell 命令
  PLUGIN: 'plugin',     // 需要安装的插件（第三方，已核实）
  SETTINGS: 'settings', // 在图形界面里改的设置项
  BEHAVIOR: 'behavior', // 无插件/配置可解时的行为建议（仍须指向具体动作）
};

/** 兼容旧名（老代码与文档里用过 RX_TYPE） */
export const RX_TYPE = {
  INSTALL: REMEDY_KIND.PLUGIN,
  BUILD: 'build',
  CONFIG: REMEDY_KIND.CONFIG,
  BEHAVIOR: REMEDY_KIND.BEHAVIOR,
};

export const KIND_LABEL = {
  [REMEDY_KIND.CONFIG]: '改配置',
  [REMEDY_KIND.COMMAND]: '跑命令',
  [REMEDY_KIND.PLUGIN]: '装插件',
  [REMEDY_KIND.SETTINGS]: '改设置',
  [REMEDY_KIND.BEHAVIOR]: '行为建议',
};

export { toPatchSnippet, formatScalar } from '../config/index.mjs';
