// 解析真实宿主包的测试夹具：默认测试不依赖临时目录，找不到就跳过并给出配置方法。
// 配置：环境变量 DSH_HISTORY_EDITOR_HOST_NODE_MODULES 指向含 @deepseek-ai/* 的 node_modules 目录。
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SESSION_REL = '@deepseek-ai/dsh-session/lib/index.js';
const CATALOG_REL = '@deepseek-ai/dsh-session-format-catalog/lib/index.js';

const ENV_KEYS = ['DSH_HISTORY_EDITOR_HOST_NODE_MODULES', 'DSH_NODE_MODULES'];

function candidates() {
  const list = [];
  for (const key of ENV_KEYS) if (process.env[key]) list.push(process.env[key]);
  // 已知的本机提取副本（仅作便利候选，不存在即跳过）。
  list.push(
    'F:/EXE/DeepSeek/resources/app.asar.unpacked/dsh/node_modules',
  );
  return list;
}

/** 返回可用的宿主 node_modules 绝对路径；没有则返回 null。 */
export function hostNodeModules() {
  for (const candidate of candidates()) {
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    if (existsSync(path.join(resolved, SESSION_REL)) && existsSync(path.join(resolved, CATALOG_REL))) return resolved;
  }
  return null;
}

/** 导入真实宿主的 Session 与格式目录；不可用时抛出带说明的错误。 */
export async function loadHost() {
  const root = hostNodeModules();
  if (!root) throw new Error('找不到真实宿主包；设置 DSH_HISTORY_EDITOR_HOST_NODE_MODULES 指向含 @deepseek-ai/* 的 node_modules');
  const toUrl = rel => pathToFileURL(path.join(root, rel)).href;
  return {
    root,
    Session: (await import(toUrl(SESSION_REL))).Session,
    SessionStore: (await import(toUrl(SESSION_REL))).SessionStore,
    catalog: (await import(toUrl(CATALOG_REL))).sessionFormatCatalog,
    TokenMeter: (await import(toUrl('@deepseek-ai/dsh-token-meter/lib/index.js'))).TokenMeter,
    Context: (await import(toUrl('@deepseek-ai/cordis/lib/index.js'))).Context,
    Service: (await import(toUrl('@deepseek-ai/cordis/lib/index.js'))).Service,
    SessionProjectionRegistry: (await import(toUrl('@deepseek-ai/dsh-session-projection/lib/index.js'))).SessionProjectionRegistry,
  };
}
