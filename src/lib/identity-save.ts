import {
  normalizeAndValidateIdentityPatch,
  type IdentityChangeSet,
  type IdentityPatch,
  type IdentitySaveResult,
} from './object-identity';
import { compareOpened } from './save-check';

export interface StoredIdentity {
  businessId?: string;
  name?: string;
  type?: string;
  templateBusinessId?: string;
}

export interface IdentitySavePort {
  lookupIdentity(rid: string, options?: { fresh?: boolean }): Promise<StoredIdentity | null>;
  applyIdentityChanges(
    rid: string,
    changes: IdentityChangeSet,
  ): Promise<{ ok: boolean; writeAttempted: boolean; error?: string }>;
}

/**
 * Save one object's editable identity and reconcile the response against an authoritative readback.
 * A BMP execute result is never treated as proof of persistence because EC writes are not atomic and
 * the transport can fail after the server has accepted a commit.
 *
 * Only the fields present in `input` are written; an absent field keeps its stored value (a rename
 * made elsewhere is not reverted by an ID edit). `expect` holds the values the user opened for the
 * edited fields: the initial read doubles as the changed-since-opened check (no extra request), and a
 * difference refuses the save with `conflict` before anything is written.
 */
export async function saveIdentity(
  port: IdentitySavePort,
  rid: string,
  input: IdentityPatch,
  assertSession: () => void = () => {},
  expect?: IdentityPatch,
): Promise<IdentitySaveResult> {
  const validation = normalizeAndValidateIdentityPatch(input);
  if (!validation.ok) return { ...validation, notSent: true };
  const requested = validation.value;

  const before = await port.lookupIdentity(rid);
  assertSession();
  if (!before) return { ok: false, error: 'Could not read the current identity.', notSent: true };

  if (expect) {
    // The identity flow trims every value it writes, so trimmed values compare.
    const opened: Record<string, string> = {};
    for (const field of ['businessId', 'name', 'templateBusinessId'] as const) {
      if (requested[field] !== undefined && expect[field] !== undefined) opened[field] = expect[field]!.trim();
    }
    const check = compareOpened(opened, field => (before[field as keyof StoredIdentity] ?? '').trim());
    if (check.state === 'changed') {
      const names = check.changes.map(c => IDENTITY_LABEL[c.prop] ?? c.prop).join(' and ');
      return {
        ok: false,
        notSent: true,
        conflict: check.changes,
        businessId: before.businessId,
        name: before.name,
        ...(before.templateBusinessId !== undefined ? { templateBusinessId: before.templateBusinessId } : {}),
        error: `${names} changed in BMP since you opened it. Nothing was saved.`,
      };
    }
  }

  const changes: IdentityChangeSet = {};
  if (requested.businessId !== undefined && before.businessId !== requested.businessId) changes.businessId = requested.businessId;
  if (requested.name !== undefined && before.name !== requested.name) changes.name = requested.name;
  if (requested.templateBusinessId !== undefined && before.templateBusinessId !== requested.templateBusinessId) {
    changes.templateBusinessId = requested.templateBusinessId;
  }

  const saved = await port.applyIdentityChanges(rid, changes);
  if (!saved.ok && !saved.writeAttempted) {
    return { ok: false, error: saved.error ?? 'Identity save failed', notSent: true };
  }

  // Old BMP versions resolve objects through cached business IDs. Once an ID changes that reference is
  // stale, so any possible write must bypass it before deciding what actually persisted.
  let stored: StoredIdentity | null = null;
  try {
    assertSession();
    stored = await port.lookupIdentity(rid, saved.writeAttempted ? { fresh: true } : undefined);
    assertSession();
  } catch {
    // The write may already have landed. A lost connection or changed account
    // prevents verification; neither is evidence that repeating it is safe.
    stored = null;
  }
  if (!stored) {
    return {
      ok: false,
      error: saved.writeAttempted
        ? 'BMP may have saved some identity values, but the verification read failed. Reload the object before retrying.'
        : 'Could not verify the current identity.',
    };
  }

  const verified = (requested.businessId === undefined || stored.businessId === requested.businessId)
    && (requested.name === undefined || stored.name === requested.name)
    && (requested.templateBusinessId === undefined || stored.templateBusinessId === requested.templateBusinessId);
  if (verified) {
    return {
      ok: true,
      businessId: stored.businessId,
      name: stored.name,
      ...(requested.templateBusinessId !== undefined ? { templateBusinessId: stored.templateBusinessId } : {}),
    };
  }

  const requestedValues = [
    ...(changes.businessId !== undefined
      ? [{ actual: stored.businessId, expected: changes.businessId }]
      : []),
    ...(changes.name !== undefined
      ? [{ actual: stored.name, expected: changes.name }]
      : []),
    ...(changes.templateBusinessId !== undefined
      ? [{ actual: stored.templateBusinessId, expected: changes.templateBusinessId }]
      : []),
  ];
  const anyRequestedValueLanded = requestedValues.some(value => value.actual === value.expected);
  const verificationError = anyRequestedValueLanded
    ? 'BMP applied only part of the identity change. The current values were refreshed; review them before retrying.'
    : 'BMP did not persist the requested identity values. The current values were refreshed for review.';
  return {
    ok: false,
    businessId: stored.businessId,
    name: stored.name,
    templateBusinessId: stored.templateBusinessId,
    error: saved.error ? `${saved.error} ${verificationError}` : verificationError,
  };
}

const IDENTITY_LABEL: Record<string, string> = { businessId: 'ID', name: 'Name', templateBusinessId: 'Template ID' };
