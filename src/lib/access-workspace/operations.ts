import { readJournal } from './journal';
import type { ReadContext } from './read';

interface Operation {
  environment: string; write: boolean; controller: AbortController; updated: number;
  state: 'running' | 'complete' | 'failed'; progress: string; result?: unknown; error?: string;
}
const operations = new Map<string, Operation>();
function validateId(id: string) {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error('Invalid operation ID.');
}
export function startOperation(id: string, environment: string, write: boolean, run: (context: ReadContext) => Promise<unknown>) {
  validateId(id);
  const existing = operations.get(id);
  if (existing) {
    if (existing.environment !== environment) throw new Error('Operation belongs to another environment.');
    return;
  }
  for (const [key, value] of operations) if (value.state !== 'running' && value.updated < Date.now() - 15 * 60_000) operations.delete(key);
  if (operations.size >= 100) throw new Error('Too many active requests. Close unused Access tabs and retry.');
  const operation: Operation = { environment, write, controller: new AbortController(), updated: Date.now(), state: 'running', progress: 'Connecting to BMP…' };
  operations.set(id, operation);
  void Promise.resolve().then(() => run({ signal: operation.controller.signal, progress: message => { operation.progress = message; operation.updated = Date.now(); } })).then(result => {
    operation.result = result; operation.state = 'complete'; operation.updated = Date.now();
  }, error => {
    operation.error = error instanceof Error ? error.message : String(error); operation.state = 'failed'; operation.updated = Date.now();
  });
}
export async function operationStatus(id: string, environment: string) {
  validateId(id);
  const operation = operations.get(id);
  if (operation) {
    if (operation.environment !== environment) throw new Error('Operation belongs to another environment.');
    return { state: operation.state, progress: operation.progress, result: operation.result, error: operation.error };
  }
  const journal = await readJournal(id);
  if (journal?.environment === environment && journal.phase === 'complete') return { state: 'complete', result: journal.result };
  return { state: 'failed', error: journal?.environment === environment
    ? `Apply was interrupted during ${journal.phase}. Its recovery record is retained. Reload from BMP to reconcile; do not repeat the write.`
    : 'The request was interrupted. Reload from BMP to continue.' };
}
export function cancelOperation(id: string, environment: string): void {
  const operation = operations.get(id);
  if (operation?.environment === environment && !operation.write) {
    operation.controller.abort(new Error('Request cancelled.'));
    operations.delete(id);
  }
}
export function releaseOperation(id: string, environment: string): void {
  const operation = operations.get(id);
  if (operation?.environment === environment && operation.state !== 'running') operations.delete(id);
}
