const URL_IN_TEXT_PATTERN = /\b(?:https?|rtmps?):\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION_PATTERN = /[),.;\]}]+$/;

/**
 * Stream URLs commonly carry short-lived bearer signatures in their query.
 * Persisted state and diagnostics only need the stable endpoint identity.
 */
export function sanitizeStreamUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    const boundary = value.search(/[?#]/);
    return boundary === -1 ? value : value.slice(0, boundary);
  }
}

/**
 * Last-resort log/notification guard for URLs embedded in arbitrary text.
 */
export function sanitizeUrlQueriesInText(value: string): string {
  return value.replace(URL_IN_TEXT_PATTERN, match => {
    const trailing = match.match(TRAILING_PUNCTUATION_PATTERN)?.[0] || '';
    const url = trailing ? match.slice(0, -trailing.length) : match;
    return `${sanitizeStreamUrl(url)}${trailing}`;
  });
}
