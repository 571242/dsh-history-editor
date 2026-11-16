// Test-process-only overlay; the extracted host and installed ASAR stay untouched.
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { patchEntry } from '../host-patch/build-current.mjs';
process.env.DSH_HISTORY_EDITOR_PATCH_PART ||= 'both';
const root = process.env.DSH_HISTORY_EDITOR_HOST_NODE_MODULES;
if (!root) throw new Error('DSH_HISTORY_EDITOR_HOST_NODE_MODULES is required');
registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith('file:')) return nextLoad(url, context);
    const file = fileURLToPath(url);
    const relative = path.relative(root, file).split(path.sep).join('/');
    const selected = process.env.DSH_HISTORY_EDITOR_PATCH_PART || 'both';
    const match = (selected !== 'format' && relative === '@deepseek-ai/dsh-session/lib/index.js')
      || (selected !== 'session' && relative === '@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js');
    if (!match) return nextLoad(url, context);
    return { format: 'module', source: patchEntry(relative, readFileSync(file)).toString('utf8'), shortCircuit: true };
  },
});
