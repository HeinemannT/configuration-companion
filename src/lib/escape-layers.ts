/**
 * Escape backs out one layer, innermost first. Each window registers its
 * layers (a dialog, a menu, a popover or card, a peek, an edit, a search
 * text or selection, a panel, the window itself) and one listener asks the
 * innermost open layer to close. A layer may decline (its close returns
 * false), and the next one out is asked.
 *
 * Order, innermost first: dialog, menu, popover, peek, edit, input, panel,
 * window. Within one kind the layer registered last is asked first.
 * Docked surfaces (side panel, Access tab, Blueprint) simply never register
 * a 'window' layer.
 */
import { matchesCombo } from './shortcuts';

export type EscapeLayerKind = 'dialog' | 'menu' | 'popover' | 'peek' | 'edit' | 'input' | 'panel' | 'window';

export const ESCAPE_ORDER: readonly EscapeLayerKind[] = ['dialog', 'menu', 'popover', 'peek', 'edit', 'input', 'panel', 'window'];

export interface EscapeLayer {
  kind: EscapeLayerKind;
  /** Short name for tests and debugging. */
  name?: string;
  /** True while the layer is showing. */
  isOpen: () => boolean;
  /** Close it. Return false to let the next layer out have the key. */
  close: (e: KeyboardEvent | null) => boolean | void;
  /** When the layer sees the key: 'capture' runs before the focused
   *  element's own handlers (menus, modal sheets), 'bubble' (default) after
   *  them, and only when none of them used the key. */
  phase?: 'capture' | 'bubble';
}

export class EscapeLayers {
  private layers: Array<{ layer: EscapeLayer; seq: number }> = [];
  private seq = 0;
  private listening = false;

  /** Add a layer; the returned function removes it. */
  register(layer: EscapeLayer): () => void {
    const entry = { layer, seq: ++this.seq };
    this.layers.push(entry);
    return () => { this.layers = this.layers.filter(l => l !== entry); };
  }

  /** The open layers, innermost first (optionally of one phase only). */
  open(phase?: 'capture' | 'bubble'): EscapeLayer[] {
    return this.layers
      .filter(l => !phase || (l.layer.phase ?? 'bubble') === phase)
      .filter(l => { try { return l.layer.isOpen(); } catch { return false; } })
      .sort((a, b) => (ESCAPE_ORDER.indexOf(a.layer.kind) - ESCAPE_ORDER.indexOf(b.layer.kind)) || b.seq - a.seq)
      .map(l => l.layer);
  }

  /** Close the innermost layer that accepts. True when one did. */
  escape(e: KeyboardEvent | null = null, phase?: 'capture' | 'bubble'): boolean {
    for (const layer of this.open(phase)) {
      if (layer.close(e) !== false) return true;
    }
    return false;
  }

  /** Keydown handler: on Escape (not composing, not already handled) close
   *  the innermost layer and stop the key. True when the key was used. */
  handle(e: KeyboardEvent, phase?: 'capture' | 'bubble'): boolean {
    if (e.defaultPrevented || e.isComposing || !matchesCombo(e, 'Escape')) return false;
    if (!this.escape(e, phase)) return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  }

  /** Listen on a document or window in both phases (each layer is asked
   *  in its own phase); returns the remover. Once per document. */
  listen(target: Document | Window): () => void {
    if (this.listening) return () => {};
    this.listening = true;
    const cap = (e: Event) => { this.handle(e as KeyboardEvent, 'capture'); };
    const bub = (e: Event) => { this.handle(e as KeyboardEvent, 'bubble'); };
    target.addEventListener('keydown', cap, true);
    target.addEventListener('keydown', bub);
    return () => {
      this.listening = false;
      target.removeEventListener('keydown', cap, true);
      target.removeEventListener('keydown', bub);
    };
  }
}

const perDocument = new WeakMap<Document, EscapeLayers>();

/** The layer stack of a document (one per window). */
export function escapeLayers(doc: Document = document): EscapeLayers {
  let s = perDocument.get(doc);
  if (!s) { s = new EscapeLayers(); perDocument.set(doc, s); }
  return s;
}
