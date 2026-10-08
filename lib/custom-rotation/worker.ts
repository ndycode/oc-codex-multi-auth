/** Fixed Node bootstrap shared by source tests and the compiled package. */
export const ROTATION_WORKER_SOURCE = String.raw`
import { writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
setInterval(() => {}, 1000);
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 1048576) process.exit(1);
}
try {
  const { module, context } = JSON.parse(input);
  const policy = await import(pathToFileURL(module).href);
  if (typeof policy.select !== 'function') throw new Error();
  const id = await policy.select(context);
  if (id !== null && (typeof id !== 'string' || id.length > 256)) throw new Error();
  await Promise.all([
    new Promise((resolve) => process.stdout.write('', resolve)),
    new Promise((resolve) => process.stderr.write('', resolve)),
  ]);
  // Keep the root alive until the host has read the entire frame and killed its tree.
  writeSync(3, JSON.stringify({ accountId: id }) + '\n');
} catch {
  writeSync(3, JSON.stringify({ error: 'policy' }) + '\n');
}
`;
