export const DEFAULT_CACHE_READ_INPUT_RATIO = 0.1;

export function defaultCacheReadPrice(
  inputPrice: number | undefined,
): number | undefined {
  return inputPrice === undefined
    ? undefined
    : inputPrice / (1 / DEFAULT_CACHE_READ_INPUT_RATIO);
}
