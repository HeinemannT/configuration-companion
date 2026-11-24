/**
 * Point and tell: the one or two words the page says when a mark has been read, in BMP's words. Pure.
 * Ink that was not understood says nothing (the comment field's placeholder already asks).
 */
import type { PtMark, PtWidgetKind } from './types';

export type TagIcon = 'move' | 'add' | 'change' | 'crossed' | 'objects' | 'note';
export interface TagSpec { word: string; icon: TagIcon }

const WIDGET_WORD: Record<PtWidgetKind, string> = { table: 'Table', chart: 'Chart', button: 'Button', text: 'Text' };

/** "PieChart" as "Pie chart": the type, in BMP's own name for it. */
export function typeWords(className: string | undefined): string {
  const words = (className ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
  return words ? words[0].toUpperCase() + words.slice(1).toLowerCase() : 'Object';
}

/** What the tag of a mark says, or null for no tag. `classOf` gives an object's type by its id. */
export function tagSpec(m: Pick<PtMark, 'meaning' | 'targets' | 'ink' | 'reading' | 'arrow'>, classOf: (id: string) => string | undefined): TagSpec | null {
  const k = m.meaning?.kind;
  if (k === 'move') return { word: 'Move', icon: 'move' };
  if (k === 'add') {
    const a = m.meaning?.kind === 'add' ? m.meaning : undefined;
    return { word: a?.tab ? 'Tab' : a?.page ? 'Page' : a?.widget ? WIDGET_WORD[a.widget] : 'Add', icon: 'add' };
  }
  if (k === 'change') return { word: 'Change', icon: 'change' };
  if (k === 'crossed') return { word: 'Crossed out', icon: 'crossed' };
  // An arrow that asks for no operation: it is read as an arrow, and the words say what it means.
  if (m.ink && m.arrow && m.reading) return { word: 'Arrow', icon: 'move' };
  if (!m.targets.length) return null;
  // A loop or a pointer: about these objects. A drawing with no reading is not understood: no tag.
  if (m.ink) return m.reading ? { word: m.targets.length > 1 ? `${m.targets.length} objects` : typeWords(classOf(m.targets[0])), icon: 'objects' } : null;
  return { word: 'Note', icon: 'note' };
}
