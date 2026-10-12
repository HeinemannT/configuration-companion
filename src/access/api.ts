import { sendRequestBounded } from '../lib/messaging';
import type { InspectorMessage } from '../lib/types';
import type { AccessRequest } from '../lib/access-workspace/model';
import { AccessResponseError, createOperationClient } from './operation-client';
export type { RequestOptions } from './operation-client';

type Response = Extract<InspectorMessage, { type: 'ACCESS_WORKSPACE_RESULT' }>;
export function createAccessApi(environment: string, progress: (text: string) => void) {
  const control = async (request: AccessRequest, signal?: AbortSignal) => {
    const response = await sendRequestBounded<Response>({ type: 'ACCESS_WORKSPACE_REQUEST', environment, request }, { timeoutMs: 20_000, signal });
    if (response.type !== 'ACCESS_WORKSPACE_RESULT' || !response.ok) throw new AccessResponseError(response.error ?? 'No complete response from Companion.');
    return response.data as any;
  };
  const client = createOperationClient(control, progress);
  if (typeof window !== 'undefined') window.addEventListener('pagehide', client.cancelReads);
  return client.request;
}
