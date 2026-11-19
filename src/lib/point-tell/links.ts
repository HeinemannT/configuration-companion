/**
 * A templated page shows its INSTANCE widgets (the page's own rids) while Point and tell works on the
 * shared TEMPLATE's layout (Blueprint's default target). The link map joins them: the rid the page shows
 * for a widget -> the id of the template widget it stands for. Read once, from the instance's own layout.
 */
import type { LModel } from '../layout/types';
import { walk } from '../layout/model';

/** Instance widget rid -> template widget id (BMP business ID). Only widgets that carry a link. */
export function linkMap(instance: LModel): Record<string, string> {
  const out: Record<string, string> = {};
  walk(instance, n => { if (n.rid && n.linkedTemplate?.id) out[n.rid] = n.linkedTemplate.id; });
  return out;
}
