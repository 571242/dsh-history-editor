import { createHistoryApi, fail } from './core.js';
import { verifyRuntime } from './verify-runtime.js';
import { mkdir, writeFile } from 'node:fs/promises';
export const name = 'dsh-history-editor';
export const inject = ['webServer', 'sessions', 'agents', 'tokenMeter'];
function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw fail('请求过大', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fail('请求不是有效 JSON', 400); }
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return req.headers['sec-fetch-site'] !== 'cross-site';
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
export async function apply(ctx) {
  // Verify on detached test objects before admitting writes to any real Session.
  const reportDir = new URL('./.scratch/', import.meta.url);
  let report;
  try { report = await verifyRuntime(ctx); }
  catch (error) { report = { ok: false, error: error.message }; }
  try {
    await mkdir(reportDir, { recursive: true });
    await writeFile(new URL('runtime-check.json', reportDir), JSON.stringify(report, null, 2));
  } catch { /* Diagnostic output is optional; the compatibility check is not. */ }
  // 只验「用户消息改写」这条路径：助手回复已不在功能范围内，删除缺宿主补丁时会在请求里
  // 明确拒绝并说明原因，不再让整块插件因补丁缺失而启动失败。
  if (!report.ok) {
    throw new Error('历史编辑宿主兼容检查失败；未启用写入：' + (report.error ?? 'replay mismatch'));
  }
  const api = createHistoryApi(ctx);
  ctx.effect(() => {
  const disposers = [];
  // remove 走与 edit/recall 相同的 POST JSON 契约，只是落到另一个方法上。
  for (const [path, method, pick] of [
    ['/history-editor/messages', 'GET', null],
    ['/history-editor/edit', 'POST', body => api.edit(body)],
    ['/history-editor/delete', 'POST', body => api.remove(body)],
    ['/history-editor/recall', 'POST', body => api.recall(body)],
  ]) {
    disposers.push(ctx.webServer.register({ kind: 'exact', path, handler: async (req, res) => {
      try {
        if (!sameOrigin(req)) throw fail('只允许当前 DSH 页面调用', 403);
        if (req.method !== method) throw fail('请求方法不支持', 405);
        if (method === 'GET') {
          const id = new URL(req.url, 'http://localhost').searchParams.get('sessionId');
          send(res, 200, api.list(id));
        } else {
          if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw fail('需要 JSON 请求', 415);
          send(res, 200, await pick(await readBody(req)));
        }
      } catch (error) { send(res, error.status ?? 500, { ok: false, error: error.message, ...(error.deleteApplied === true ? { deleteApplied: true } : {}) }); }
    } }));
  }
  return () => { for (const dispose of disposers) if (typeof dispose === 'function') dispose(); };
  }, 'history-editor:routes');
}
