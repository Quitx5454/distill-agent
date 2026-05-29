import { RawRow, ColumnDefinition, Features, DistillOutput, BotDetectionResult } from '../../utils/types';

// HATA 2 DÜZELTMESİ: Hem Unix timestamp (sayı) hem ISO string desteklenir.
// GeckoTerminal "2026-05-28T20:13:59Z" formatında gönderiyor.
// Number() ile ISO string'e çevirmek NaN üretir, bu yüzden ayrı kontrol gerekir.
function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && !isNaN(value)) return value;
  if (typeof value === 'string') {
    const ms = new Date(value).getTime();
    if (!isNaN(ms)) return ms / 1000; // saniyeye çevir, tutarlılık için
  }
  return null;
}

function findPeakActivity(rows: RawRow[], timestampColumns: string[]): string {
  if (timestampColumns.length === 0) return 'unknown';

  const hourCounts: Record<number, number> = {};
  for (const row of rows) {
    const ts = parseTimestamp(row[timestampColumns[0]]);
    if (ts === null) continue;
    const hour = new Date(ts * 1000).getUTCHours();
    hourCounts[hour] = (hourCounts[hour] || 0) + 1;
  }

  if (Object.keys(hourCounts).length === 0) return 'unknown';

  const peakHour = Number(
    Object.entries(hourCounts).sort((a, b) => b[1] - a[1])[0][0]
  );

  return `${String(peakHour).padStart(2, '0')}:00-${String(peakHour + 1).padStart(2, '0')}:00 UTC`;
}

function findRecurringPatterns(rows: RawRow[], addressColumns: string[]): string[] {
  if (addressColumns.length < 2) return [];

  const pairCounts: Record<string, number> = {};
  for (const row of rows) {
    const from = String(row[addressColumns[0]]).slice(0, 8);
    const to = String(row[addressColumns[1]]).slice(0, 8);
    const key = `${from}→${to}`;
    pairCounts[key] = (pairCounts[key] || 0) + 1;
  }

  return Object.entries(pairCounts)
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([pair, count]) => `${pair} (${count}x)`);
}

// HATA 1 DÜZELTMESİ: Her satır için yalnızca bir hacim sütunu kullanılır.
// Önceki calcVolume tüm amount sütunlarını topluyordu — aynı işlem birden fazla sayılıyordu.
// Örnek: "amount" ve "amount_usd" ikisi de toplanınca değer iki katına çıkıyordu.
// Çözüm: Her satır için amount sütunlarını sırayla dene, ilk geçerli değerde dur.
function calcVolume(rows: RawRow[], amountColumns: string[]): number {
  let total = 0;
  for (const row of rows) {
    for (const col of amountColumns) {
      const val = Number(row[col]);
      if (!isNaN(val) && val > 0) {
        total += val;
        break; // Bu satır için ilk geçerli sütunu aldık, diğerlerine bakma
      }
    }
  }
  return Math.round(total * 100) / 100;
}

export function extractFeatures(
  botResult: BotDetectionResult,
  columns: ColumnDefinition[]
): DistillOutput {
  const addressColumns = columns.filter(c => c.type === 'address').map(c => c.name);
  const amountColumns = columns.filter(c => c.type === 'amount').map(c => c.name);
  const timestampColumns = columns.filter(c => c.type === 'timestamp').map(c => c.name);

  // Üç grubu ayır
  const cleanRows = botResult.rows
    .filter(r => r.classification.label === 'clean')
    .map(r => r.row);

  const suspiciousRows = botResult.rows
    .filter(r => r.classification.label === 'suspicious')
    .map(r => r.row);

  const botRows = botResult.rows
    .filter(r => r.classification.label === 'bot')
    .map(r => r.row);

  // HATA 1 DÜZELTMESİ: totalVolume = cleanVolume + suspiciousVolume + botVolume
  // Önceden botVolume dahil edilmiyordu, parçaların toplamı büyük çıkıyordu.
  const cleanVolume = calcVolume(cleanRows, amountColumns);
  const suspiciousVolume = calcVolume(suspiciousRows, amountColumns);
  const botVolume = calcVolume(botRows, amountColumns);
  const totalVolume = Math.round((cleanVolume + suspiciousVolume + botVolume) * 100) / 100;

  // volumeConfidence: temiz verinin toplam hacme yüzdesi
  const volumeConfidence = totalVolume > 0
    ? `${Math.round((cleanVolume / totalVolume) * 100)}%`
    : '0%';

  // HATA 3 DÜZELTMESİ: uniqueSenders — gönderen cüzdan adresleri sayılır.
  // Önceden addressColumns[1] (token contract adresi) okunuyordu → hep 2 çıkıyordu.
  // GeckoTerminal verisinde addressColumns[0] = attributes_tx_from_address (gönderen cüzdan).
  // Bu yüzden [0] indeksi kullanılır ve feature adı uniqueSenders olarak değiştirildi.
  const senders = new Set<string>();
  if (addressColumns.length >= 1) {
    for (const row of cleanRows) {
      const val = String(row[addressColumns[0]]);
      if (val && val !== 'undefined' && val !== 'null') {
        senders.add(val);
      }
    }
  }

  const avgTransactionSize = cleanRows.length > 0 && amountColumns.length > 0
    ? Math.round((cleanVolume / cleanRows.length) * 100) / 100
    : 0;

  const features: Features = {
    totalVolume,
    cleanVolume,
    suspiciousVolume,
    botVolume,
    volumeConfidence,
    uniqueCounterparties: senders.size, // artık uniqueSenders sayısı
    avgTransactionSize,
    peakActivity: findPeakActivity(cleanRows, timestampColumns),
    recurringPatterns: findRecurringPatterns(cleanRows, addressColumns),
  };

  const { total, bot, suspicious, clean } = botResult.summary;

  return {
    summary: {
      total_transactions: total,
      bot_filtered: bot,
      suspicious,
      clean_transactions: clean,
      bot_ratio: `${Math.round((bot / total) * 100)}%`,
    },
    warnings: botResult.warnings,
    features,
    clean_data: cleanRows,
    suspicious_data: suspiciousRows,
  };
}