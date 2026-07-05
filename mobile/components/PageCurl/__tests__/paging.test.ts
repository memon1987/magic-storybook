// FC-024: behavior tests for the reader's page-label helper.
//
// `readerPageLabel` decides what the bottom bar shows for every page,
// including the synthetic cover (FC-012) and synthetic "The End" page
// (FC-022). Each case below pins a label a user actually reads; any
// off-by-one at either seam (cover boundary, end-page boundary) fails here.

import { readerPageLabel } from '../paging';

describe('readerPageLabel', () => {
  describe('cover + end page (production shape since FC-022)', () => {
    // 7 total = cover + 5 story pages + "The End"
    const base = { pageCount: 7, hasCover: true, hasEndPage: true };

    it('labels index 0 as the cover', () => {
      expect(readerPageLabel({ ...base, index: 0 })).toBe('Cover');
    });

    it('labels the final index as The End', () => {
      expect(readerPageLabel({ ...base, index: 6 })).toBe('The End');
    });

    it('labels the first story page 1 / 5 (cover offset applied)', () => {
      expect(readerPageLabel({ ...base, index: 1 })).toBe('1 / 5');
    });

    it('labels the last story page 5 / 5 (end page excluded from total)', () => {
      expect(readerPageLabel({ ...base, index: 5 })).toBe('5 / 5');
    });
  });

  describe('cover only', () => {
    const base = { pageCount: 6, hasCover: true, hasEndPage: false };

    it('labels index 0 as the cover', () => {
      expect(readerPageLabel({ ...base, index: 0 })).toBe('Cover');
    });

    it('labels a middle page with the cover excluded from the total', () => {
      expect(readerPageLabel({ ...base, index: 3 })).toBe('3 / 5');
    });

    it('labels the final index as a story page, not The End', () => {
      expect(readerPageLabel({ ...base, index: 5 })).toBe('5 / 5');
    });
  });

  describe('end page only', () => {
    const base = { pageCount: 6, hasCover: false, hasEndPage: true };

    it('labels the final index as The End', () => {
      expect(readerPageLabel({ ...base, index: 5 })).toBe('The End');
    });

    it('labels index 0 as story page 1 (no cover offset)', () => {
      expect(readerPageLabel({ ...base, index: 0 })).toBe('1 / 5');
    });
  });

  describe('no synthetic pages', () => {
    const base = { pageCount: 5, hasCover: false, hasEndPage: false };

    it('labels index 0 as 1 / 5', () => {
      expect(readerPageLabel({ ...base, index: 0 })).toBe('1 / 5');
    });

    it('labels the final index as 5 / 5', () => {
      expect(readerPageLabel({ ...base, index: 4 })).toBe('5 / 5');
    });
  });
});
