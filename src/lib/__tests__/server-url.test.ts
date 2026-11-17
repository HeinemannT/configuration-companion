import { describe, it, expect } from 'vitest';
import { parseServerUrl, workspaceLabelFor } from '../server-url';
import { originPatternFor } from '../site-access';

const url = (raw: string) => {
  const r = parseServerUrl(raw);
  if (!r.ok) throw new Error(`expected ok for ${raw}: ${r.error}`);
  return r.url;
};

describe('parseServerUrl', () => {
  it('adds https:// to a scheme-less address, so a permission origin exists', () => {
    expect(url('demo.corporater.dev/CorpoWebserver')).toBe('https://demo.corporater.dev/CorpoWebserver/');
    // The bug: the raw value has no origin pattern, so no prompt could appear.
    expect(originPatternFor('demo.corporater.dev/CorpoWebserver')).toBeNull();
    expect(originPatternFor(url('demo.corporater.dev/CorpoWebserver'))).toBe('https://demo.corporater.dev/*');
  });

  it('trims whitespace and keeps an explicit http scheme and port', () => {
    expect(url('  http://bmp.intra:8080/Ws  ')).toBe('http://bmp.intra:8080/Ws/');
    expect(url('localhost:8080/Ws')).toBe('https://localhost:8080/Ws/');
  });

  it('reduces a pasted deep link to the workspace root', () => {
    expect(url('https://bmp.example.com/Steadfast-DEV/?isHome=true&rid=8915779932974873453&selectedPeriodType=M'))
      .toBe('https://bmp.example.com/Steadfast-DEV/');
    expect(url('https://host/Ws/web/scorecard?rid=1#/x')).toBe('https://host/Ws/');
    expect(url('host/Ws/cs/authentication')).toBe('https://host/Ws/');
    expect(url('https://host/Ws/index.html')).toBe('https://host/Ws/');
    expect(url('https://host/#/page')).toBe('https://host/');
  });

  it('keeps a multi-segment context path', () => {
    expect(url('https://host/bmp/Ws/')).toBe('https://host/bmp/Ws/');
  });

  it('rejects values that cannot be a BMP workspace address, with a reason', () => {
    for (const raw of ['', '   ', 'ftp://host/Ws', 'javascript:alert(1)', 'host name/Ws', 'https://user:pw@host/Ws', 'https://ho$t/Ws']) {
      const r = parseServerUrl(raw);
      expect(r.ok, raw).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(10);
    }
  });

  it('labels a new profile with the workspace name', () => {
    expect(workspaceLabelFor('https://host/Steadfast-DEV/')).toBe('Steadfast-DEV');
    expect(workspaceLabelFor('https://host/')).toBe('host');
  });
});
