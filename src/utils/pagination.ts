const MAX_PAGE_SIZE = 100;

export function normalizePagination(
  limitValue: string | number | undefined,
  offsetValue: string | number | undefined,
  defaultLimit: number
): { limit: number; offset: number } {
  const parsedLimit = Number.parseInt(String(limitValue ?? ''), 10);
  const parsedOffset = Number.parseInt(String(offsetValue ?? ''), 10);

  return {
    limit:
      Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, MAX_PAGE_SIZE)
        : defaultLimit,
    offset:
      Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0,
  };
}
