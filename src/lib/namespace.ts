/**
 * BMP namespace resolution — maps className to ID-space prefix.
 *
 * A reference like "k.pMyProp" resolves to the property object with businessId "pMyProp"
 * under root.PROPERTY in any BMP workspace.
 *
 * Ported from crev/src/tools/transport-tool/lib/namespace.ts.
 * Used by: BMP object hover (pattern validation), future transport features.
 */

/** className → namespace prefix */
import { isMac, shortcutLabel } from './shortcuts';
import { resolveDisplayIdentity } from './object-identity';

const NAMESPACE_MAP: Record<string, string> = {
  // Groups / Access / Roles
  Organisation: 'o', User: 'u', Group: 'g', ROLE: 'role',
  AccessPolicy: 'acpol', ACCESSPROFILE: 'ap', DEFAULTS: 'd', ClassConfig: 'c', SystemMethodConfig: 'c',

  // Resources
  FileResource: 'r', TranslationFile: 'r', APIResource: 'r', RemoteResource: 'r',
  APIEndpoint: 'r', APIClientAuthentication: 'r', EndpointParameter: 'r',
  LogFolder: 'r', CorpoLog: 'r', SqlResource: 'r', PowerBiResource: 'r',

  // Properties
  TextMethodConfig: 'k', ListMethodConfig: 'k', HistoricalListMethodConfig: 'k',
  HistoricalReferenceMethodConfig: 'k', HistoricalTextMethodConfig: 'k',
  RichTextMethodConfig: 'k', ExtendedMethodConfig: 'k', TokenMethodConfig: 'k',
  HistoricalRichTextMethodConfig: 'k', HistoricalDateMethodConfig: 'k',
  BooleanMethodConfig: 'k', ReferenceMethodConfig: 'k', UrlMethodConfig: 'k',
  FunctionMethodConfig: 'k', HistoricalNumberMethodConfig: 'k', NumberMethodConfig: 'k',
  DateMethodConfig: 'k', TagMethodConfig: 'k', HistoricalBooleanMethodConfig: 'k',
  ListPropertySet: 'k', ListPropertySetItem: 'k',

  // Categories / Templates / Portal
  Category: 't', ExtendedExpression: 't', ProcessDefinition: 't', Transformer: 't',

  // Enterprise objects
  CEVENDOR: 'ceven', CETASK: 'cetas', CECOMMENT: 'cecom', CEINCIDENT: 'ceinc',
  CEPROCEDURE: 'cepro', CEPOLICY: 'cepol', CECONTROLMEASURE: 'cecme',
  CEISSUE: 'ceiss', CEASSET: 'ceass', CESERVICE: 'ceser', CECONTRACT: 'cecot',
  CEPROJECT: 'ceprj', CEREGULATION: 'cereg', CECOMPLIANCEREQUIREMENT: 'cecor',
  CEINDICATOR: 'ceind', CEATTACHMENT: 'ceatt', CERISKASSESSMENT: 'ceras',
  CEPRODUCT: 'ceprd', CEPRESCREENING: 'cepsc', CEPRIVACY: 'ceprv',
  CEWORKFLOW: 'cewfl', CEDISTRIBUTION: 'cedis', CEINQUIRY: 'ceinq',
  CEQUESTIONNAIRE: 'ceqst', CEDPIA: 'cedpi', CETIA: 'cetia', CEASSURANCEACTIVITY: 'ceasa',
};

/** All valid namespace prefixes (for hover pattern validation) */
const VALID_PREFIXES = new Set(Object.values(NAMESPACE_MAP));
// Add prefixes that aren't derivable from the map
VALID_PREFIXES.add('t');   // default for most portal objects
VALID_PREFIXES.add('o');   // organisation space
VALID_PREFIXES.add('u');   // user space
VALID_PREFIXES.add('s');   // scorecard space
VALID_PREFIXES.add('p');   // legacy property space

/** ID spaces a bare business ID is looked up in, most common first. Every
 *  prefix here answers `<prefix>.get("…")` (checked against BMP 5.6). */
export const ID_SPACES: readonly string[] = [...new Set(['t', 'o', 'k', 'r', 'u', 'g', ...Object.values(NAMESPACE_MAP)])];

// ── Copy strategy (shared across all copy surfaces) ──────────

export interface CopyableIdentity {
  rid: string;
  businessId?: string;
  type?: string;
  templateBusinessId?: string;
}

export type CopyModifier = 'plain' | 'shift' | 'ctrl' | 'alt';

/** What a copy gesture copies. One scheme and four terms ("ID", "RID",
 *  "Instance ID", "Reference") for every in-page copy surface (badges, the
 *  hover card) and the editor's identity badge:
 *  - `id`: the ID configurators work with — the template ID when the object
 *    has one, else its own ID (plain click);
 *  - `rid`: the RID (Shift-click), as in the object window;
 *  - `instance`: the object's own ID when it differs from the ID, else the
 *    ID itself, named "ID" (Alt-click);
 *  - `reference`: `<idspace>.<instance ID>` (Ctrl/Cmd-click). */
export type CopyKind = 'id' | 'rid' | 'instance' | 'reference';

export const COPY_KIND_FOR_MODIFIER: Readonly<Record<CopyModifier, CopyKind>> = {
  plain: 'id',
  shift: 'rid',
  alt: 'instance',
  ctrl: 'reference',
};

export type CopyLabel = 'ID' | 'RID' | 'Instance ID' | 'Reference';

export interface CopyChoice {
  /** The kind actually copied: an Alt-click on an object whose instance ID
   *  is its ID copies (and names) the ID. */
  kind: CopyKind;
  /** Empty when the object has no value of this kind: copy nothing. */
  text: string;
  label: CopyLabel;
  /** Says what is missing when `text` is empty. */
  missing: string;
}

const MISSING: Record<CopyKind, string> = {
  id: 'No ID to copy: this object has no ID',
  rid: 'No RID to copy: this object has no RID',
  instance: 'No Instance ID to copy: this object has no ID',
  reference: 'No Reference to copy: this object has no ID',
};

/** The ID the plain click copies (template ID, else instance ID). */
function primaryId(identity: CopyableIdentity): string {
  const display = resolveDisplayIdentity({ templateBusinessId: identity.templateBusinessId, businessId: identity.businessId });
  return display.primaryKind === 'missing' ? '' : display.primary;
}

/** The instance ID only when it is a value of its own (differs from the ID). */
export function distinctInstanceId(identity: CopyableIdentity): string {
  const instance = identity.businessId?.trim() || '';
  return instance && instance !== primaryId(identity) ? instance : '';
}

/** The value of one copy kind. Never falls back to the RID: a copy that
 *  silently put the RID on the clipboard instead of an ID was the confusing
 *  part of the old scheme. */
export function resolveCopyKind(identity: CopyableIdentity, kind: CopyKind): CopyChoice {
  const instance = identity.businessId?.trim() || '';
  switch (kind) {
    case 'rid':
      return { kind, text: identity.rid?.trim() || '', label: 'RID', missing: MISSING.rid };
    case 'reference':
      return { kind, text: instance ? `${resolveNamespace(identity.type ?? '')}.${instance}` : '', label: 'Reference', missing: MISSING.reference };
    case 'instance': {
      const distinct = distinctInstanceId(identity);
      if (distinct) return { kind, text: distinct, label: 'Instance ID', missing: MISSING.instance };
      return { kind: 'id', text: primaryId(identity), label: 'ID', missing: MISSING.instance };
    }
    default:
      return { kind: 'id', text: primaryId(identity), label: 'ID', missing: MISSING.id };
  }
}

/** The "still loading" message for a copy whose value is not known yet. */
export function loadingMessage(kind: CopyKind): string {
  const label: Record<CopyKind, CopyLabel> = { id: 'ID', rid: 'RID', instance: 'Instance ID', reference: 'Reference' };
  return `No ${label[kind]} to copy yet: the object details are still loading`;
}

/** Resolve what a click with `modifier` copies. Used by overlay badges and
 *  the editor's identity badge. */
export function resolveCopyText(identity: CopyableIdentity, modifier: CopyModifier): CopyChoice {
  return resolveCopyKind(identity, COPY_KIND_FOR_MODIFIER[modifier]);
}

/** Extract copy modifier from a mouse event. Mixed modifiers resolve in a
 *  fixed order: Alt, then Ctrl/Cmd, then Shift. */
export function getModifier(e: MouseEvent): CopyModifier {
  if (e.altKey) return 'alt';
  if (e.ctrlKey || e.metaKey) return 'ctrl';
  if (e.shiftKey) return 'shift';
  return 'plain';
}

/** True on macOS, where the reference copy is Cmd-click. */
export function isMacPlatform(): boolean {
  return isMac();
}

/** The modifier legend, in the order of the scheme: [key, what it copies].
 *  The Instance ID entry appears only where an Instance ID row exists. */
export function copyLegend(mac = isMacPlatform(), withInstance = true): ReadonlyArray<readonly [string, string]> {
  return [
    ['Click', 'ID'],
    ['Shift', 'RID'],
    ...(withInstance ? [[mac ? 'Option' : 'Alt', 'Instance ID'] as const] : []),
    [mac ? 'Cmd' : 'Ctrl', 'Reference'],
  ];
}

/** Standard tooltip text for copy controls with modifier support. */
export const COPY_TOOLTIP = 'Copy ID (Shift: RID; Alt: Instance ID; Ctrl/Cmd: Reference)';

/** Accessible description of a badge's click scheme. */
export const BADGE_DESCRIPTION = `Space or click copies the ID; Shift copies RID, Alt Instance ID, Ctrl or Cmd Reference. Double-click or ${shortcutLabel('inspect.open')} opens the object window. ${shortcutLabel('inspect.card')} opens the details. ${shortcutLabel('inspect.next')} and ${shortcutLabel('inspect.prev')} move to the next or previous badge.`;

// ── Namespace validation ─────────────────────────────────────

/** Check if a prefix is a valid BMP namespace. */
export function isValidNamespace(prefix: string): boolean {
  return VALID_PREFIXES.has(prefix);
}

/** Namespaces `resolveNamespace` gives for some class (the map's prefixes
 *  and the default `t`): an object's namespace is known from its class only
 *  for these. */
export function isClassNamespace(prefix: string): boolean {
  return prefix === 't' || Object.values(NAMESPACE_MAP).includes(prefix);
}

// Case-insensitive lookup table. BMP classNames are PascalCase
// (`CeRiskAssessment`), but the enterprise block of NAMESPACE_MAP was
// authored ALL-CAPS (`CERISKASSESSMENT`). A direct lookup therefore MISSED
// for every Ce* type and fell back to `t.`, producing dead references like
// `t.113` (correct: `ceras.113`) when ctrl-clicking a pill. Normalising both
// sides to upper-case fixes the whole enterprise block at once and is robust
// to className-vs-typeKey casing differences.
const NAMESPACE_MAP_UC: Record<string, string> = Object.fromEntries(
  Object.entries(NAMESPACE_MAP).map(([k, v]) => [k.toUpperCase(), v]),
);

/** Resolve a className to its namespace prefix (case-insensitive). */
export function resolveNamespace(className: string): string {
  return NAMESPACE_MAP_UC[className.toUpperCase()] ?? 't';
}

/** ClassNames that carry code properties (expression, html, javascript). */
export const CODE_BEARING_TYPES = new Set([
  'ExtendedMethodConfig', 'ExtendedTable', 'ExtendedExpression',
  'ReferenceMethodConfig', 'HistoricalReferenceMethodConfig',
  'CustomVisualization', 'DashboardHTML',
]);
