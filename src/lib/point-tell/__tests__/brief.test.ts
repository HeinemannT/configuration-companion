import { describe, expect, it } from 'vitest';
import { briefAddress, buildBrief, quoted, type BriefInput } from '../brief';
import { container, fixtureModel, widget } from './fixture';
import type { PtMark, PtPlace } from '../types';

// The fixture page: tab Overview [ container "Col 6" (tbl_open_risks "Open risks", chart_by_status "By status"),
// container "Notes" (txt_info "Info"), btn_new_risk "New risk", btn_export "Export" ], tab Details [ dv_details ].
const m = (n: number, extra: Partial<PtMark>): PtMark => ({ n, text: '', targets: [], at: n, ...extra });
const ink = (place: Record<string, unknown> = {}) => ({ strokes: [{ points: [[0, 0], [9, 9]] as Array<[number, number]> }], place });
const base = (marks: PtMark[], extra: Partial<BriefInput> = {}): BriefInput => ({
  model: fixtureModel(), marks, liveTabId: 'tab_overview', server: { name: 'Steadfast DEV', address: 'https://bmp.example.test/Steadfast/?rid=7282092580979928955' }, ...extra,
});
const OPEN = 'Change request for a Corporater BMP page, sketched in Configuration Companion.';

describe('the brief, one kind of mark at a time', () => {
  it('the lines are numbered from 1 without gaps, even when the page mark took the first internal number', () => {
    const page = m(1, { text: 'Vendor review', ink: ink(), meaning: { kind: 'add', page: true, place: { before: 'x' } as unknown as PtPlace } });
    const t = buildBrief(base([m(2, { text: 'first note' }), m(4, { text: 'second note' }), m(7, { text: 'third note' })]));
    expect(t).toContain('1. Note for the whole page: "first note"');
    expect(t).toContain('2. Note for the whole page: "second note"');
    expect(t).toContain('3. Note for the whole page: "third note"');
    expect(t).not.toContain('4. Note');
    // A mark that drew a page is the page line, not a numbered line, and does not take a number.
    const withPage = buildBrief(base([page, m(2, { text: 'first note' })]));
    expect(withPage).toContain('1. Note for the whole page: "first note"');
    expect(withPage).not.toContain('2. Note');
  });

  it('a note for the whole page', () => {
    const t = buildBrief(base([m(1, { text: 'tighten the spacing' })]));
    expect(t).toContain('1. Note for the whole page: "tighten the spacing"');
  });

  it('a comment on one object (a click)', () => {
    const t = buildBrief(base([m(1, { text: 'why two?', targets: ['btn_export'] })]));
    expect(t).toContain('1. Comment on button "Export" (ActionButton, btn_export). The user says: "why two?"');
  });

  it('a circle around two buttons, with the words', () => {
    const t = buildBrief(base([m(1, { text: 'one menu instead of two buttons', targets: ['btn_new_risk', 'btn_export'], reading: '2 objects', ink: ink() })]));
    expect(t).toContain('1. Circle around buttons "New risk" (ActionButton, btn_new_risk) and "Export" (ActionButton, btn_export). The user says: "one menu instead of two buttons"');
  });

  it('a circle without words has no "user says" and no guess', () => {
    const t = buildBrief(base([m(1, { targets: ['tbl_open_risks'], reading: 'Open risks', ink: ink() })]));
    expect(t).toContain('1. Circle around "Open risks" (ExtendedTable, tbl_open_risks).\n');
    expect(t).not.toContain('The user says');
    expect(t).not.toContain('Our guess');
  });

  it('an arrow from an object to a place: the guess is labelled', () => {
    const t = buildBrief(base([m(1, { targets: ['btn_export'], meaning: { kind: 'move', to: { after: 'txt_info' } }, ink: ink() })]));
    expect(t).toContain('1. Arrow from "Export" (ActionButton, btn_export) to just after "Info" (TextElement, txt_info). Our guess: move it there.');
  });

  it('an arrow into a square says the width', () => {
    const t = buildBrief(base([m(1, { targets: ['btn_export'], meaning: { kind: 'move', to: { after: 'tbl_open_risks' }, columns: 2 }, ink: ink({ tabId: 'tab_overview', row: 3, col: 5, cols: 2 }) })]));
    expect(t).toContain('1. Arrow from "Export" (ActionButton, btn_export) into a square at row 3, columns 5-6. Our guess: move it there, about 2 columns wide.');
  });

  it('a square on empty space: what is inside, the guess, the words', () => {
    const t = buildBrief(base([m(1, { text: 'open actions by owner', meaning: { kind: 'add', place: { after: 'tbl_open_risks' }, widget: 'chart', columns: 2 }, ink: ink({ tabId: 'tab_overview', row: 2, col: 5, cols: 2 }) })]));
    expect(t).toContain('1. Square on empty space at row 2, columns 5-6, with bars drawn inside. Our guess: a new chart, about 2 columns wide. The user says: "open actions by owner"');
  });

  it('a square with no grid place falls back to the object it goes after', () => {
    const t = buildBrief(base([m(1, { meaning: { kind: 'add', place: { after: 'tbl_open_risks' } }, ink: ink() })]));
    expect(t).toContain('1. Square on empty space. Our guess: a new widget, just after "Open risks" (ExtendedTable, tbl_open_risks).');
  });

  it('a square in another tab and a container names both', () => {
    const t = buildBrief(base([m(1, { meaning: { kind: 'add', place: { into: 'cont_notes' }, widget: 'table' }, ink: ink({ tabId: 'tab_details', containerId: 'cont_notes', row: 1, col: 1, cols: 3 }) })]));
    expect(t).toContain('Square on empty space on tab "Details" (tab_details), inside container "Notes" (cont_notes), at row 1, columns 1-3, with lines across drawn inside. Our guess: a new table.');
  });

  it('a cross has no guess; the words stay the user\'s', () => {
    const t = buildBrief(base([m(1, { text: 'nobody reads this', targets: ['txt_info'], meaning: { kind: 'crossed' }, ink: ink() })]));
    expect(t).toContain('1. Cross over "Info" (TextElement, txt_info). The user says: "nobody reads this"');
    expect(t).not.toContain('Our guess');
  });

  it('an underline', () => {
    const t = buildBrief(base([m(1, { text: 'say Open instead', targets: ['btn_export'], meaning: { kind: 'change' }, ink: ink() })]));
    expect(t).toContain('1. Underline under button "Export" (ActionButton, btn_export). The user says: "say Open instead"');
  });

  it('an arrow from empty space onto an object is pointing, not moving', () => {
    const t = buildBrief(base([m(1, { targets: ['txt_info'], pointer: true, reading: 'Info', ink: ink() })]));
    expect(t).toContain('1. Arrow pointing at "Info" (TextElement, txt_info).');
    expect(t).not.toContain('Our guess');
  });

  it('ink that was not understood says so, near an object or on a place', () => {
    const near = buildBrief(base([m(1, { targets: ['tbl_open_risks'], ink: ink() })]));
    expect(near).toContain('Freehand ink near "Open risks" (ExtendedTable, tbl_open_risks), not a shape Companion recognised.');
    const placed = buildBrief(base([m(1, { text: 'something here', ink: ink({ tabId: 'tab_overview', row: 4, col: 1, cols: 2 }) })]));
    expect(placed).toContain('1. Freehand ink at row 4, columns 1-2, not a shape Companion recognised. The user says: "something here"');
    expect(buildBrief(base([m(1, { ink: ink() })]))).toContain('Freehand ink on the page, not a shape');
  });

  it('a drawn tab is described as new, with its name as the name, not as words', () => {
    const t = buildBrief(base([m(1, { text: 'Contracts', meaning: { kind: 'add', tab: true, place: { after: 'tab_overview' } }, ink: ink() })]));
    expect(t).toContain('1. The user drew a new tab "Contracts" after tab "Overview" (tab_overview). It is a sketch and does not exist in BMP.');
    expect(t).not.toContain('The user says');
    expect(t).not.toContain('Our guess');
    const unnamed = buildBrief(base([m(1, { meaning: { kind: 'add', tab: true, place: { before: 'tab_details' } }, ink: ink() })]));
    expect(unnamed).toContain('The user drew a new tab with no name yet before tab "Details" (tab_details). It is a sketch and does not exist in BMP.');
  });

  it('a sketch inside a drawn tab says "in the new tab"', () => {
    const marks = [
      m(1, { text: 'Contracts', meaning: { kind: 'add', tab: true, place: { after: 'tab_details' } }, ink: ink() }),
      m(2, { text: 'open contracts', meaning: { kind: 'add', place: { into: 'draft:1' }, widget: 'table', columns: 6 }, ink: ink({ tabId: 'draft:1', row: 1, col: 1, cols: 6 }) }),
    ];
    const t = buildBrief(base(marks));
    expect(t).toContain('2. Square on empty space in the new tab "Contracts", at row 1, columns 1-6, with lines across drawn inside. Our guess: a new table, about 6 columns wide. The user says: "open contracts"');
  });
});

describe('a drawn tab that is on screen', () => {
  it('is named where its sketches sit, and is not given as the shown tab of the page', () => {
    const marks = [
      m(1, { text: 'Contracts', meaning: { kind: 'add', tab: true, place: { after: 'tab_details' } }, ink: ink() }),
      m(2, { text: 'open contracts', meaning: { kind: 'add', place: { into: 'draft:1' }, widget: 'table', columns: 6 }, ink: ink({ tabId: 'draft:1', row: 1, col: 1, cols: 6 }) }),
    ];
    const t = buildBrief(base(marks, { liveTabId: 'draft:1' }));
    expect(t).toContain('Page: "Operational Risk" (Scorecard, ID sc_op_risk)\nServer:');
    expect(t).toContain('2. Square on empty space in the new tab "Contracts", at row 1');
  });
});

describe('where the user is', () => {
  it('a plain page: name, type, business ID, the shown tab, the server and the address; no template line', () => {
    const t = buildBrief(base([m(1, { text: 'x' })]));
    expect(t.startsWith(`${OPEN}\n\nPage: "Operational Risk" (Scorecard, ID sc_op_risk), tab "Overview"\nServer: Steadfast DEV, https://bmp.example.test/Steadfast/?rid=7282092580979928955\n\n1. `)).toBe(true);
    expect(t).not.toContain('Template:');
  });

  it('a templated page: the viewed page, the template and how many pages use it', () => {
    const t = buildBrief(base([m(1, { text: 'x' })], {
      model: { ...fixtureModel(), pageId: 'tpl_supplier', pageName: 'Supplier template' },
      viewed: { id: 'supplier_risk', name: 'Supplier risk' },
      template: { id: 'tpl_supplier', name: 'Supplier template', className: 'Scorecard', shared: true, pages: 295 },
    }));
    expect(t).toContain('Page: "Supplier risk" (Scorecard, ID supplier_risk), tab "Overview"\nTemplate: "Supplier template" (Scorecard, ID tpl_supplier). Layout changes go on the template and show on every page that uses it (295 pages); the values shown belong to "Supplier risk".\n');
  });

  it('the Home page through its page template', () => {
    const t = buildBrief(base([m(1, { text: 'x' })], {
      model: { ...fixtureModel(), pageId: 'home_scorecard', pageName: 'Home' },
      viewed: { id: 'home', name: 'Home' },
      template: { id: 'home_scorecard', name: 'Home', className: 'Scorecard', shared: true, pages: null },
    }));
    expect(t).toContain('Page: "Home" (Scorecard, ID home), tab "Overview"\nTemplate: "Home" (Scorecard, ID home_scorecard). Layout changes go on the template and show on every page that uses it; the values shown belong to "Home".\n');
  });

  it('an organisation shown through an EnterpriseTemplate: the organisation is the page, the template says where changes land', () => {
    const t = buildBrief(base([m(1, { text: 'x' })], {
      model: { ...fixtureModel(), pageId: 'organisation_template', pageName: 'Organisation', pageClass: 'EnterpriseTemplate' },
      viewed: { id: 'europe', name: 'Europe', className: 'Organisation' },
      template: { id: 'organisation_template', name: 'Organisation', className: 'EnterpriseTemplate', shared: true, pages: null },
    }));
    expect(t).toContain('Page: "Europe" (Organisation, ID europe), tab "Overview"\nTemplate: "Organisation" (EnterpriseTemplate, ID organisation_template). Layout changes go on the template and show on every Organisation that uses it; the values shown belong to "Europe".\n');
    expect(t).not.toContain('Page: "Organisation"');
  });

  it('a risk shown through an EnterpriseTemplate, with an ID BMP assigned', () => {
    const t = buildBrief(base([m(1, { text: 'x' })], {
      model: { ...fixtureModel(), pageId: 'risk_template', pageName: 'Risk', pageClass: 'EnterpriseTemplate' },
      viewed: { id: '1042', name: 'Supplier insolvency', className: 'CeRisk' },
      template: { id: 'risk_template', name: 'Risk', className: 'EnterpriseTemplate', shared: true, pages: null },
    }));
    expect(t).toContain('Page: "Supplier insolvency" (CeRisk, numeric ID 1042), tab "Overview"\nTemplate: "Risk" (EnterpriseTemplate, ID risk_template). Layout changes go on the template and show on every CeRisk that uses it; the values shown belong to "Supplier insolvency".');
  });

  it('an object through an EnterpriseTemplate whose own type and ID are not known never calls itself the template', () => {
    const t = buildBrief(base([m(1, { text: 'x' })], {
      model: { ...fixtureModel(), pageId: 'organisation_template', pageName: 'Organisation', pageClass: 'EnterpriseTemplate' },
      viewed: { name: 'Europe' },
      template: { id: 'organisation_template', name: 'Organisation', className: 'EnterpriseTemplate', shared: true, pages: null },
    }));
    expect(t).toContain('Page: "Europe", tab "Overview"\nTemplate: "Organisation" (EnterpriseTemplate, ID organisation_template). Layout changes go on the template and show on every object that uses it; the values shown belong to "Europe".');
  });

  it('a template whose page count is not known yet says only that other pages use it', () => {
    const t = buildBrief(base([m(1, { text: 'x' })], { viewed: { id: 'supplier_risk' }, template: { id: 'tpl_supplier', shared: true, pages: null } }));
    expect(t).toContain('Page: (Scorecard, ID supplier_risk)');
    expect(t).toContain('Template: (ID tpl_supplier). Layout changes go on the template and show on every page that uses it.');
  });

  it('a templated page marked as this instance only', () => {
    const t = buildBrief(base([m(1, { text: 'x' })], { template: { id: 'tpl_supplier', shared: false } }));
    expect(t).toContain('Page: "Operational Risk" (Scorecard, ID sc_op_risk), tab "Overview"\nTemplate: (ID tpl_supplier). The marks are about this page only, not the template.');
  });

  it('a paper page: a sketch that does not exist, and the page it was drawn from', () => {
    const model = { ...fixtureModel(), pageId: 'draft:page', pageName: 'Vendor review', tabs: [], resultOnly: true };
    const t = buildBrief(base([m(1, { text: 'Contracts', meaning: { kind: 'add', tab: true, place: { into: 'draft:page' } }, ink: ink() })], {
      model, liveTabId: null, newPage: { name: 'Vendor review', from: { name: 'Operational Risk', id: 'sc_op_risk', className: 'Scorecard' } },
    }));
    expect(t).toContain('Page: the user sketched a new page "Vendor review", past the last breadcrumb of "Operational Risk" (Scorecard, ID sc_op_risk). It is a sketch and does not exist in BMP.');
    expect(t).toContain('1. The user drew a new tab "Contracts" on the tab row. It is a sketch and does not exist in BMP.');
    expect(t).not.toContain('Template:');
    expect(t).not.toMatch(/created|Blueprint|stage/i);
  });

  it('no server profile and no address: the line is left out', () => {
    expect(buildBrief(base([m(1, { text: 'x' })], { server: undefined }))).not.toContain('Server:');
    expect(buildBrief(base([m(1, { text: 'x' })], { server: { name: 'DEV' } }))).toContain('Server: DEV\n');
  });
});

describe('objects without a business ID', () => {
  it('say so and give where the object is; never a long internal rid', () => {
    const model = fixtureModel();
    model.tabs[0].children.push(container('1000000000000000009', 6, [widget('1000000000000000010', 'TextElement', 3, 'Loose text', { rid: '1000000000000000010' })], 'Loose'));
    const t = buildBrief(base([m(1, { text: 'x', targets: ['1000000000000000010'], meaning: { kind: 'crossed' }, ink: ink() })], { model }));
    expect(t).toContain('Cross over "Loose text" (TextElement, no business ID, 1st in "Loose")');
    expect(t).not.toContain('1000000000000000010');
  });

  it('a short numeric ID is given and said to be only a number', () => {
    const model = fixtureModel();
    model.tabs[0].children.push(widget('4711', 'TextElement', 3, 'Numbered'));
    const t = buildBrief(base([m(1, { text: 'x', targets: ['4711'], meaning: { kind: 'crossed' }, ink: ink() })], { model }));
    expect(t).toContain('"Numbered" (TextElement, numeric ID 4711)');
  });

  it('an object whose name is its ID says the ID once', () => {
    const model = fixtureModel();
    model.tabs[0].children.push(widget('admin_hub_navigation', 'ExtendedTable', 3, 'admin_hub_navigation'));
    model.tabs[0].children.push(widget('4712', 'TextElement', 3, '4712'));
    const t = buildBrief(base([m(1, { text: 'x', targets: ['admin_hub_navigation'], meaning: { kind: 'crossed' }, ink: ink() }), m(2, { text: 'y', targets: ['4712'], meaning: { kind: 'crossed' }, ink: ink() })], { model }));
    expect(t).toContain('1. Cross over ExtendedTable ID admin_hub_navigation.');
    expect(t).toContain('2. Cross over TextElement numeric ID 4712.');
    expect(t).not.toContain('"admin_hub_navigation"');
  });

  it('an object that left the page is said so', () => {
    expect(buildBrief(base([m(1, { text: 'x', targets: ['gone'] })]))).toContain('Comment on an object that is no longer on the page');
  });
});

describe('the whole text', () => {
  const marks = (): PtMark[] => [
    m(1, { text: 'one menu instead of two buttons', targets: ['btn_new_risk', 'btn_export'], reading: '2 objects', ink: ink() }),
    m(2, { targets: ['btn_export'], meaning: { kind: 'move', to: { after: 'tbl_open_risks' } }, ink: ink() }),
    m(3, { text: 'open actions by owner', meaning: { kind: 'add', place: { after: 'tbl_open_risks' }, widget: 'chart', columns: 2 }, ink: ink({ tabId: 'tab_overview', row: 2, col: 5, cols: 2 }) }),
    m(4, { text: 'nobody reads this', targets: ['txt_info'], meaning: { kind: 'crossed' }, ink: ink() }),
    m(5, { text: 'tighten the spacing' }),
  ];

  it('closes with the guesses line when a mark has a guess, else without it', () => {
    expect(buildBrief(base(marks()))).toContain("Guesses are Companion's reading of the drawing and can be wrong; the user's words win. Ask before changing anything that is unclear.\n");
    const t = buildBrief(base([m(1, { text: 'x', targets: ['btn_export'], meaning: { kind: 'crossed' }, ink: ink() })]));
    expect(t.trimEnd().endsWith("The user's words win. Ask before changing anything that is unclear.")).toBe(true);
    expect(t).not.toContain('Guesses are');
  });

  it('a screenshot adds one line before the closing line', () => {
    const t = buildBrief(base(marks(), { screenshot: true }));
    expect(t).toContain('5. Note for the whole page: "tighten the spacing"\n\nA picture with the same numbers is attached.\n\nGuesses are');
    expect(buildBrief(base(marks()))).not.toContain('A picture');
  });

  it('is plain text: no JSON, no short refs, no outline, no vocabulary, no answer format', () => {
    const t = buildBrief(base(marks()));
    expect(t).not.toMatch(/[{}[\]]/);
    expect(t).not.toMatch(/\b[otcn]\d+\b/);
    for (const w of ['outline', 'vocabulary', 'answer', 'operations', 'rid']) expect(t.toLowerCase()).not.toContain(w === 'rid' ? 'rid":' : w);
  });

  it('six mixed marks stay well under 1,500 characters', () => {
    const six = [...marks(), m(6, { text: 'rename it', targets: ['tbl_open_risks'], meaning: { kind: 'change' }, ink: ink() })];
    const t = buildBrief(base(six));
    expect(t.length).toBeLessThan(1500);
  });

  it('a long page name is not cut; quotes and line breaks in words stay on one line', () => {
    expect(quoted('say "hi"\nthere')).toBe('"say \\"hi\\" there"');
    const t = buildBrief(base([m(1, { text: 'line one\nline two' })]));
    expect(t).toContain('1. Note for the whole page: "line one line two"');
  });
});

describe('the page address', () => {
  it('keeps the page and the tab only: no period, no home flag, no credentials, no fragment', () => {
    expect(briefAddress('https://user:pw@bmp.example.test/Steadfast/?rid=123456&token=abc&selectedPeriod=1793487600000&selectedPeriodType=M&isHome=true#/frag')).toBe('https://bmp.example.test/Steadfast/?rid=123456');
  });
  it('adds the shown tab, which BMP does not write into the address when it is clicked', () => {
    expect(briefAddress('https://bmp.example.test/Steadfast/?rid=123456&selectedPeriod=1', '5237019819559862902')).toBe('https://bmp.example.test/Steadfast/?rid=123456&tabrid=5237019819559862902');
    expect(briefAddress('https://bmp.example.test/Steadfast/?rid=123456&tabrid=777777', null)).toBe('https://bmp.example.test/Steadfast/?rid=123456&tabrid=777777');
    expect(briefAddress('https://bmp.example.test/Steadfast/?rid=123456', 'not-a-rid')).toBe('https://bmp.example.test/Steadfast/?rid=123456');
  });
  it('an address without a rid keeps its other parameters, minus secret-looking ones', () => {
    expect(briefAddress('https://bmp.example.test/app/?view=home&token=abc')).toBe('https://bmp.example.test/app/?view=home');
  });
  it('is null for anything that is not a web address', () => {
    expect(briefAddress(undefined)).toBeNull();
    expect(briefAddress('chrome://settings')).toBeNull();
    expect(briefAddress('nonsense')).toBeNull();
  });
});
