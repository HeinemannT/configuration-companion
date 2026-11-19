/**
 * The page's requests to the service worker. Every request is routed to the
 * server the page was opened for (setRouteHint in colors-images.ts); a write
 * also names it (`environment`), and the worker refuses it when the server
 * changed in Companion since.
 */
import { sendRequest } from '../lib/messaging';
import type { InspectorMessage } from '../lib/types';
import type { ImageFile, ImageFolder } from '../lib/colors-images/image-files';
import type { ColorOp, FileOp } from '../lib/colors-images/write-ops';
import type { ColorSetData } from '../lib/types';

type Reply<T extends InspectorMessage['type']> = Extract<InspectorMessage, { type: T }>;

async function ask<T extends InspectorMessage['type']>(msg: InspectorMessage, type: T): Promise<Reply<T>> {
  const reply = await sendRequest(msg);
  if (!reply) throw new Error('No answer from the extension. Reload this page.');
  if (reply.type === 'REQUEST_FAILED') throw new Error(reply.error);
  if (reply.type !== type) throw new Error('Unexpected answer from the extension.');
  return reply as Reply<T>;
}

export interface ColorRead { sets: ColorSetData[]; fetchedAt: number | null; error?: string }

export async function readColors(force: boolean): Promise<ColorRead> {
  const r = await ask({ type: 'FETCH_COLOR_SETS', ...(force ? { force: true } : {}) }, 'COLOR_SETS_DATA');
  if (r.error && r.sets.length === 0) throw new Error(r.error);
  return { sets: r.sets, fetchedAt: r.fetchedAt ?? null, ...(r.error ? { error: r.error } : {}) };
}

export interface ImageRead { folders: ImageFolder[]; files: ImageFile[]; fetchedAt: number | null; error?: string }

export async function readImages(force: boolean): Promise<ImageRead> {
  const r = await ask({ type: 'IMAGE_INDEX', ...(force ? { force: true } : {}) }, 'IMAGE_INDEX_DATA');
  if (!r.ok) throw new Error(r.error ?? 'The image files could not be read');
  return { folders: r.folders ?? [], files: r.files ?? [], fetchedAt: r.fetchedAt ?? null, ...(r.error ? { error: r.error } : {}) };
}

export interface FileBytes { rid: string; mime?: string; base64?: string; error?: string }

export async function readImageBytes(rids: string[]): Promise<FileBytes[]> {
  const r = await ask({ type: 'IMAGE_BYTES', rids }, 'IMAGE_BYTES_DATA');
  if (!r.ok) throw new Error(r.error ?? 'The images could not be read');
  return r.items;
}

export interface WriteOutcome { ok: boolean; written: number; error?: string; outcomeUnknown?: boolean }

export async function writeChanges(environment: string, colors: ColorOp[], files: FileOp[]): Promise<WriteOutcome> {
  const r = await ask({
    type: 'COLORS_IMAGES_WRITE', environment,
    ...(colors.length ? { colors } : {}), ...(files.length ? { files } : {}),
  }, 'COLORS_IMAGES_WRITE_RESULT');
  return { ok: r.ok, written: r.written, ...(r.error ? { error: r.error } : {}), ...(r.outcomeUnknown ? { outcomeUnknown: true } : {}) };
}
