/**
 * The color tools of the Colors tab: three ways to type a value, the
 * distance that marks a color close to one already in the sets, the scale
 * from one color, the white-text nudge and colors found in pasted text.
 */
import { describe, expect, it } from 'vitest';
import {
  CLOSE_DISTANCE, closeMatch, colorDistance, contrastRatio, deltaE2000, formatColor, hexToLab, hslToRgb, parseColor, rgbToHex, rgbToHsl, scaleFrom, whitePassNudge,
} from '../color-math';
import { nameFromLabel, parsePastedColors } from '../color-paste';

describe('one value, three ways to type it', () => {
  it('shows a value as hex, RGB and HSL', () => {
    expect(formatColor('#0F8A9D', 'hex')).toBe('#0F8A9D');
    expect(formatColor('#0F8A9D', 'rgb')).toBe('15, 138, 157');
    expect(formatColor('#0F8A9D', 'hsl')).toBe('188, 83%, 34%');
  });

  it('reads what is typed in the chosen format, and any format written out in full', () => {
    expect(parseColor('0f8a9d')).toBe('#0F8A9D');
    expect(parseColor('15, 138, 157', 'rgb')).toBe('#0F8A9D');
    expect(parseColor('15 138 157', 'rgb')).toBe('#0F8A9D');
    expect(parseColor('rgb(15, 138, 157)')).toBe('#0F8A9D');
    expect(parseColor('rgba(15,138,157,0.5)')).toBe('#0F8A9D');
    expect(parseColor('rgb(100%, 0%, 0%)')).toBe('#FF0000');
    expect(parseColor('hsl(188, 83%, 34%)')).toBe(parseColor('188, 83%, 34%', 'hsl'));
    expect(parseColor('#0F8A9D', 'rgb')).toBe('#0F8A9D');
    // Not a color: out of range, a word, numbers in the hex format.
    expect(parseColor('300, 0, 0', 'rgb')).toBeNull();
    expect(parseColor('teal')).toBeNull();
    expect(parseColor('15, 138, 157')).toBeNull();
    expect(parseColor('0, 120%, 50%', 'hsl')).toBeNull();
  });

  it('round-trips HSL without drift on whole bytes', () => {
    for (const hex of ['#0F8A9D', '#14324A', '#E07B24', '#FFFFFF', '#000000', '#808080']) {
      expect(rgbToHex(hslToRgb(rgbToHsl({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5), 16) })))).toBe(hex);
    }
  });
});

describe('close to an existing color', () => {
  it('computes CIEDE2000 as the reference pairs give it', () => {
    // Sharma, Wu and Dalal (2005), pairs 1 and 17.
    expect(deltaE2000({ L: 50, a: 2.6772, b: -79.7751 }, { L: 50, a: 0, b: -82.7485 })).toBeCloseTo(2.0425, 3);
    expect(deltaE2000({ L: 50, a: 2.5, b: 0 }, { L: 73, a: 25, b: -18 })).toBeCloseTo(27.1492, 3);
    expect(deltaE2000({ L: 50, a: 2.5, b: 0 }, { L: 50, a: 0, b: -2.5 })).toBeCloseTo(4.3065, 3);
    expect(hexToLab('#FFFFFF').L).toBeCloseTo(100, 2);
  });

  it('marks a re-typed brand value as close and a different hue as not', () => {
    const known = [{ hex: '#0F8A9D', name: 'Steadfast teal' }, { hex: '#14324A', name: 'Steadfast navy' }];
    expect(closeMatch('#0E8A9C', known)?.name).toBe('Steadfast teal');
    expect(closeMatch('#0F8A9D', known)?.name).toBe('Steadfast teal');
    expect(closeMatch('#1E5F74', known)).toBeNull();
    expect(closeMatch('#E07B24', known)).toBeNull();
    // The threshold: one step of a byte is far below it; an obvious change is above it.
    expect(colorDistance('#0F8A9D', '#108B9E')).toBeLessThan(1);
    expect(colorDistance('#0F8A9D', '#0C8091')).toBeGreaterThan(CLOSE_DISTANCE);
  });
});

describe('white text nudge', () => {
  it('offers the lightest value of the same hue where white passes', () => {
    const n = whitePassNudge('#0F8A9D')!;
    expect(contrastRatio(n, '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
    // The nearest: one step lighter would fail.
    expect(contrastRatio(n, '#FFFFFF')).toBeLessThan(4.7);
    expect(colorDistance(n, '#0F8A9D')).toBeLessThan(8);
  });

  it('says nothing when white passes or is far off', () => {
    expect(whitePassNudge('#14324A')).toBeNull();
    expect(whitePassNudge('#E9D8B4')).toBeNull();
  });
});

describe('scale from a color', () => {
  it('gives five steps from light to dark around the base as 500', () => {
    const s = scaleFrom('#0F8A9D');
    expect(s.map(x => x.step)).toEqual([100, 300, 500, 700, 900]);
    expect(s[2].hex).toBe('#0F8A9D');
    const L = s.map(x => hexToLab(x.hex).L);
    for (let i = 1; i < L.length; i++) expect(L[i]).toBeLessThan(L[i - 1]);
    expect(L[0]).toBeGreaterThan(90);
    expect(L[4]).toBeLessThan(25);
  });
});

describe('colors in pasted text', () => {
  it('finds hex and rgb values with the label before each', () => {
    const text = 'Primary     #0E8A9C\nSecondary   #F2A541\nSuccess     rgb(36, 161, 72)\nDanger      #DA1E28\nSurface     #F6F4EF';
    expect(parsePastedColors(text)).toEqual([
      { name: 'Primary', hex: '#0E8A9C' }, { name: 'Secondary', hex: '#F2A541' }, { name: 'Success', hex: '#24A148' },
      { name: 'Danger', hex: '#DA1E28' }, { name: 'Surface', hex: '#F6F4EF' },
    ]);
  });

  it('reads CSS custom properties and SCSS variables, and leaves CSS property names out', () => {
    const css = ':root {\n  --brand-teal: #0F8A9D;\n  --brandNavy: #14324a;\n}\n$signal-orange: #e07b24;\n.btn { color: #fff; background: rgba(0,0,0,.5); }';
    expect(parsePastedColors(css)).toEqual([
      { name: 'Brand teal', hex: '#0F8A9D' }, { name: 'Brand navy', hex: '#14324A' }, { name: 'Signal orange', hex: '#E07B24' },
      { name: '', hex: '#FFFFFF' }, { name: '', hex: '#000000' },
    ]);
  });

  it('takes a name from the line above, or after the value, and lists a value once', () => {
    const guide = 'Ocean\nHEX #0F8A9D\nCMYK 90 12 0 38\n\n#14324A Deep navy\nnavy again: #14324A\nSand (#e9d8b4)\n#abcdef80';
    expect(parsePastedColors(guide)).toEqual([
      { name: 'Ocean', hex: '#0F8A9D' }, { name: 'Deep navy', hex: '#14324A' }, { name: 'Sand', hex: '#E9D8B4' }, { name: '', hex: '#ABCDEF' },
    ]);
  });

  it('makes names of labels', () => {
    expect(nameFromLabel('  --brand-primary: ')).toBe('Brand primary');
    expect(nameFromLabel('successGreen =')).toBe('Success green');
    expect(nameFromLabel('• Accent –')).toBe('Accent');
    expect(nameFromLabel('background-color:')).toBe('');
    expect(nameFromLabel('123')).toBe('');
  });
});
