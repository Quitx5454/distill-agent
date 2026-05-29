import { RawRow } from './types';

// Tek bir objeyi düz hale getirir
// { a: { b: 1 } } → { a_b: 1 }
function flattenObject(obj: Record<string, unknown>, prefix = ''): RawRow {
  const result: RawRow = {};

  for (const [key, value] of Object.entries(obj)) {
    const newKey = prefix ? `${prefix}_${key}` : key;

    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      const nested = flattenObject(value as Record<string, unknown>, newKey);
      Object.assign(result, nested);
    } else {
      result[newKey] = value;
    }
  }

  return result;
}

// Gelen veriyi analiz eder ve gerekirse düzleştirir
export function normalizeInput(data: unknown[]): RawRow[] {
  if (data.length === 0) return [];

  return data.map((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return { value: item };
    }
    return flattenObject(item as Record<string, unknown>);
  });
}