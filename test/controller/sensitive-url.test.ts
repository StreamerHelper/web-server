import {
  sanitizeStreamUrl,
  sanitizeUrlQueriesInText,
} from '../../src/utils/sensitive-url';

describe('sensitive URL sanitization', () => {
  it('removes stream URL query and fragment credentials', () => {
    expect(
      sanitizeStreamUrl(
        'https://pull.example/live.flv?auth_key=secret&expire=1#fragment'
      )
    ).toBe('https://pull.example/live.flv');
  });

  it('preserves queryless URLs and sanitizes URLs embedded in text', () => {
    expect(sanitizeStreamUrl('rtmp://pull.example/live')).toBe(
      'rtmp://pull.example/live'
    );
    expect(
      sanitizeUrlQueriesInText(
        'failed https://pull.example/live.flv?auth_key=secret, retry https://example.com/ok'
      )
    ).toBe(
      'failed https://pull.example/live.flv, retry https://example.com/ok'
    );
  });
});
