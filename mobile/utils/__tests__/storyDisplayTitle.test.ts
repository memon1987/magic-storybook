import { deleteDisplayTitle } from '../storyDisplayTitle';

describe('deleteDisplayTitle (FC-039)', () => {
  it('returns the trimmed title when present', () => {
    expect(
      deleteDisplayTitle({ title: 'The Brave Little Fox', childName: 'Mia' })
    ).toBe('The Brave Little Fox');
  });

  it('trims surrounding whitespace from a real title', () => {
    expect(
      deleteDisplayTitle({ title: '  Space Cats  ', childName: 'Leo' })
    ).toBe('Space Cats');
  });

  it('falls back to the child-name form when title is undefined', () => {
    expect(deleteDisplayTitle({ title: undefined, childName: 'Ava' })).toBe(
      'Story for Ava'
    );
  });

  it('falls back to the child-name form when title is an empty string', () => {
    expect(deleteDisplayTitle({ title: '', childName: 'Noah' })).toBe(
      'Story for Noah'
    );
  });

  it('falls back to the child-name form when title is whitespace-only', () => {
    expect(deleteDisplayTitle({ title: '   ', childName: 'Zoe' })).toBe(
      'Story for Zoe'
    );
  });
});
