export interface PriceRow {
  provider?: string;
  modelPrefix: string;
  effectiveFrom?: string;
  input: number;
  cachedInput?: number;
  cacheWriteShort?: number;
  cacheWriteLong?: number;
  output: number;
  fastMultiplier?: number;
  tierThreshold?: number;
  tierInput?: number;
  tierCachedInput?: number;
  tierCacheWriteShort?: number;
  tierCacheWriteLong?: number;
  tierOutput?: number;
  note?: string;
}

export interface PricingGlobals {
  webSearchPer1k?: number;
  inferenceGeoUsMultiplier?: number;
}

export interface CostTokens {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  webSearch?: number;
}

export interface CostOpts {
  speed?: string;
  tier?: string;
  geo?: string;
}

export function findPrice(rows: PriceRow[], model: string, day?: string): PriceRow | null;
export function promptTokens(t: CostTokens): number;
export function tierFor(row: PriceRow | null, prompt: number): "base" | "long";
export function unitPrices(
  row: PriceRow,
  tier?: string,
): { input: number; cachedInput: number; cacheWriteShort: number; cacheWriteLong: number; output: number };
export function costOf(row: PriceRow | null, tokens: CostTokens, opts?: CostOpts, globals?: PricingGlobals): number;
export function round(n: number, dp: number): number;
