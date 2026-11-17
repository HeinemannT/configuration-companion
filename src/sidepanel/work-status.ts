import type { ActivityEntry, InspectorMessage } from '../lib/types';

export interface WorkStatus {
  text: string;
  title?: string;
  working: boolean;
}

const working = (text: string, title?: string): WorkStatus => ({ text, title, working: true });
const settled = (text: string, title?: string): WorkStatus => ({ text, title, working: false });

/**
 * Small, user-facing summary of work crossing the panel port.
 *
 * This intentionally covers meaningful waits and outcomes rather than every
 * protocol message. Background state sync (GET_SETTINGS, GET_PAGE_INFO, …)
 * should not make the footer chatter during startup.
 */
export function workStatusForMessage(msg: InspectorMessage): WorkStatus | null {
  switch (msg.type) {
    case 'CONNECTION_TEST': return working('Checking connection…');
    case 'SET_ACTIVE_PROFILE': return working('Switching server…');
    case 'SAVE_PROFILE': return working('Saving server…');
    case 'PROFILE_VERDICT': return settled(msg.ok ? 'Server saved' : 'Server saved, not connected', msg.text);
    // Only a profile picked by hand is announced; a window following its
    // front page changes quietly.
    case 'PROFILE_SWITCHED': return msg.manual ? settled(`Switched to ${msg.label}`) : null;
    case 'CLEAR_CACHE': return working('Clearing cache…');
    case 'RESET_ALL': return working('Resetting state…');

    case 'FETCH_INBOUND':
      return working('Loading relations…');
    case 'INBOUND_RESULT':
      return settled(!msg.ok ? 'Relations load failed' : 'Relations loaded');

    // Browse shows its own progress and counts (group headers); a footer
    // count would disagree with the list (totalHits counts hits the list
    // cannot show, and the identity pass answers twice).
    case 'BROWSE_SEARCH':
    case 'BROWSE_SEARCH_RESULT':
      return null;
    case 'SERVER_LOAD':
      // The script memory notice is quiet: a settled line, not work in progress.
      return msg.sentence ? working(msg.sentence) : settled(msg.notice ?? 'Server load normal');
    case 'CODE_SEARCH_START': return working('Searching code…');
    case 'CODE_SEARCH_DONE':
      return settled(msg.cancelled ? 'Code search stopped' : msg.error ? 'Code search failed' : `${msg.outcome?.matches ?? 0} matches`);
    case 'CODE_INDEX_STATUS':
      return msg.status.state === 'building' || msg.status.state === 'refreshing'
        ? working(msg.status.progress?.toRead ? `Copying code ${msg.status.progress.read}/${msg.status.progress.toRead}` : 'Copying code…')
        : null;

    case 'FETCH_COLOR_SETS': return working('Loading colors…');
    case 'COLOR_SETS_DATA': return settled(msg.error ? 'Color load failed' : 'Colors loaded');
    case 'FETCH_TYPE_SCHEMA':
    case 'FETCH_TYPE_SCHEMAS':
    case 'FETCH_TYPE_OPTIONS':
      return working('Loading fields…');
    case 'FETCH_TYPE_SCHEMA_RESULT':
    case 'FETCH_TYPE_SCHEMAS_RESULT':
    case 'FETCH_TYPE_OPTIONS_RESULT':
      return settled('ok' in msg && !msg.ok ? 'Field load failed' : 'Fields loaded');
    case 'FETCH_PROPERTY_APPLICATIONS': return working('Loading applications…');
    case 'PROPERTY_APPLICATIONS_RESULT':
      return settled(msg.ok ? 'Applications loaded' : 'Application load failed');

    case 'SAVE_PROPERTY':
    case 'SAVE_IDENTITY':
    case 'APPLY_OBJECT_CHANGES':
    case 'APPLY_CUSTOM_CHANGES':
      return working('Saving changes…');
    case 'SAVE_RESULT':
    case 'SAVE_IDENTITY_RESULT':
    case 'APPLY_CHANGES_RESULT':
    case 'APPLY_CUSTOM_CHANGES_RESULT':
      return settled(msg.ok ? 'Changes saved' : 'Save failed');

    case 'RE_ENRICH':
      return working('Refreshing badges…');
    case 'BADGE_ENRICHMENT': {
      const count = Object.keys(msg.enrichments).length;
      return settled(`${count} ${count === 1 ? 'object' : 'objects'} enriched`);
    }

    case 'LAYOUT_LOAD': return working('Loading Blueprint…');
    case 'LAYOUT_LOAD_RESULT': return settled(msg.ok ? 'Blueprint ready' : 'Blueprint load failed');
    case 'LAYOUT_APPLY': return working('Applying Blueprint…');
    case 'LAYOUT_APPLY_RESULT':
      return settled(msg.ok ? (msg.noop ? 'Blueprint unchanged' : 'Blueprint applied') : 'Blueprint apply failed');
    case 'LAYOUT_PORTABLE_ID_PREFLIGHT': return working('Checking IDs…');
    case 'LAYOUT_PORTABLE_ID_PREFLIGHT_RESULT':
      return settled(msg.ok ? 'IDs ready' : 'ID check failed');
    case 'LAYOUT_BLAST': return working('Checking impact…');
    case 'LAYOUT_BLAST_RESULT': return settled('Impact check ready');
    case 'LAYOUT_FLOW_REFS':
    case 'LAYOUT_FLOW_REF_CHILDREN':
      return working('Loading flow options…');
    case 'LAYOUT_FLOW_REFS_RESULT':
    case 'LAYOUT_FLOW_REF_CHILDREN_RESULT':
      return settled(msg.ok ? 'Flow options ready' : 'Flow options failed');

    case 'AI_TEST': return working('Testing AI…');
    case 'AI_LIST_MODELS': return working('Loading AI models…');
    case 'AI_CHAT_SEND':
    case 'AI_REQUEST':
      return working('AI working…');
    case 'AI_PREVIEW_CODE': return working('Previewing code…');
    case 'AI_TEST_RESULT': return settled(msg.ok ? 'AI connected' : 'AI test failed');
    case 'AI_MODELS_RESULT': return settled(msg.ok ? 'AI models loaded' : 'AI models failed');
    case 'AI_PREVIEW_RESULT': return settled(msg.ok ? 'Preview ready' : 'Preview failed');

    default:
      return null;
  }
}

/**
 * Activity-log copy can be descriptive; the footer cannot. Keep its summary
 * terse while retaining the original entry as the hover title.
 */
export function compactActivityStatus(entry: ActivityEntry): WorkStatus {
  const message = entry.message.trim();
  // Badge naming (older entries say "Enriching" / "Enriched").
  const enriching = /^(?:Enriching|Naming)\s+(\d+)(?:\s+(?:objects?|page badges?))?(?:\s+from\s+server)?(?:\.\.\.|…)?$/i.exec(message);
  if (enriching) return working(`Naming ${enriching[1]} badges…`, message);

  const enriched = /^(?:Enriched|Named)\s+(\d+)\s+(?:objects?|page badges?)/i.exec(message);
  if (enriched) {
    const count = Number(enriched[1]);
    return settled(`${count} ${count === 1 ? 'badge' : 'badges'} named`, message);
  }

  // Objects the page itself reported (the interceptor), not a search count.
  const read = /^Found\s+(\d+)\s+objects?$/i.exec(message);
  if (read) {
    const count = Number(read[1]);
    return settled(`Read ${count} page ${count === 1 ? 'object' : 'objects'}`, message);
  }

  if (/^(?:Testing (?:command )?connection|Checking the connection)/i.test(message)) return working('Checking connection…', message);
  if (/^(?:Injecting content script|Connecting to the page)/i.test(message)) return working('Connecting to the page…', message);
  if (/^(?:Content script connected|Companion ready on this page)/i.test(message)) return settled('Page connected', message);

  return {
    text: message,
    title: message,
    working: /(?:\.\.\.|…)$/.test(message),
  };
}
