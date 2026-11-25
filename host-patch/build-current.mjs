import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FORMAT = '@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js';
const SESSION = '@deepseek-ai/dsh-session/lib/index.js';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const EXPECTED = {
  [FORMAT]: 'da0b0c2e1460316e659f48f4222730962046b3634d1fb634683bb7243a7bba80',
  [SESSION]: 'd9911b5e1585bcb142d03ce46eb2990b3fc7c254de5a76d3ffb124bd2469216c',
};
function once(text, before, after) {
  if (text.split(before).length !== 2) throw new Error('Patch anchor must occur exactly once: ' + before);
  return text.replace(before, after);
}
// Keep ASAR offsets unchanged. Reclaim only documentation comments, never runtime code.
function sameLength(text, bytes) {
  const comments = /\/\*\*[\s\S]*?\*\//g;
  let deficit = Buffer.byteLength(text) - bytes;
  text = text.replace(comments, comment => {
    if (deficit <= 0) return comment;
    const saved = Buffer.byteLength(comment);
    deficit -= saved;
    return '';
  });
  if (Buffer.byteLength(text) > bytes) throw new Error('Insufficient documentation padding');
  return Buffer.from(text + ' '.repeat(bytes - Buffer.byteLength(text)));
}
export function patchEntry(relative, original) {
  let text = original.toString('utf8');
  if (EXPECTED[relative] && sha(original) !== EXPECTED[relative]) throw new Error('Unrecognized rc.3 entry: ' + relative);
  if (relative === FORMAT) {
    text = once(text, '\trequireStep(event, data) {', `\thistoryDeletion(event, data) {
    const op = event.surfaceOp, audit = data.historyEditor, message = data.message;
    if (this.step !== null || event.type !== "system/message" || !op || op.op !== "replace" || op.startSeq !== op.endSeq || !audit || audit.op !== "delete" || !message || message.role !== "system" || message.source?.kind !== "system-prompt" || !Array.isArray(message.content) || message.content.length !== 0) return false;
    const seq = op.startSeq, target = this.artifact.events[seq];
    return seq !== this.protectedHead && this.surface.includes(seq) && target?.type === "user/message" && target.data.role === "user" && target.data.source?.kind === "user" && Array.isArray(audit.removedIds) && audit.removedIds.length === 1 && audit.removedIds[0] === target.data.id && Array.isArray(event.sourceEventSeqs) && event.sourceEventSeqs.length === 1 && event.sourceEventSeqs[0] === seq && this.artifact.events.some(prior => prior.seq < event.seq && prior.type === "step/start" && prior.data.turn === data.turn && prior.data.step === data.step);
  }
\trequireStep(event, data) {
    if (this.historyDeletion(event, data)) return;`);
    text = once(text, 'if (event.type === "system/message" && this.surface.length > 0 && this.protectedHead === void 0)', 'if (event.type === "system/message" && this.surface.length > 0 && this.protectedHead === void 0 && !this.historyDeletion(event, event.data))');
    text = once(text, 'if (STEP_EVENT_TYPES.has(event.type)) this.requireStep(event, data);', 'if (data.historyEditor !== void 0 && !this.historyDeletion(event, data)) throw new SessionFormatError("invalid history deletion carrier");\n\t\tif (STEP_EVENT_TYPES.has(event.type)) this.requireStep(event, data);');
    text += '\nexport const historyEditorProtocol = 1;\n';
  } else if (relative === SESSION) {
    // Namespace import fails closed if only Session (not the strict codec) was patched.
    text = 'import * as historyEditorCodec from "@deepseek-ai/dsh-session-format-v3-to-v4";\n' + text;
    text = once(text, 'var Session = class Session {', 'var Session = class Session {\n get historyEditorProtocol() { return historyEditorCodec.historyEditorProtocol === 1 ? 1 : 0; }');
  } else throw new Error('Unknown patch entry: ' + relative);
  return sameLength(text, original.length);
}
export function buildCurrent(root, output) {
  const patches = [FORMAT, SESSION].map(relative => {
    const original = readFileSync(path.join(root, relative));
    const patched = patchEntry(relative, original);
    const destination = path.join(output, 'files', 'dsh', 'node_modules', relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, patched);
    return { path: 'dsh/node_modules/' + relative, originalSha256: sha(original), patchedSha256: sha(patched), originalBytes: original.length, patchedBytes: patched.length };
  });
  const manifest = { hostVersion: '0.2.2-rc.3', protocol: 1, mode: 'equal-length-entry-spans', patches };
  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] || process.env.DSH_HISTORY_EDITOR_HOST_NODE_MODULES;
  if (!root) throw new Error('Set DSH_HISTORY_EDITOR_HOST_NODE_MODULES or pass NODE_MODULES OUTPUT_DIR');
  console.log(JSON.stringify(buildCurrent(root, process.argv[3] || path.join(path.dirname(fileURLToPath(import.meta.url)), 'current')), null, 2));
}
