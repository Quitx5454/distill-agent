import {
  RawRow,
  ColumnDefinition,
  BotSignal,
  SignalDetail,
  BotClassification,
  BotDetectionResult,
  BotDetectionWarnings,
} from '../../utils/types';

// ── SINYAL 1: YÜKSEK FREKANS ──────────────────────────────────────────────
// Aynı adresten 60 saniye içinde 5+ işlem → kesin bot davranışı
function detectHighFrequency(
  row: RawRow,
  allRows: RawRow[],
  addressColumns: string[],
  timestampColumns: string[]
): SignalDetail | null {
  if (addressColumns.length === 0 || timestampColumns.length === 0) return null;

  const address = String(row[addressColumns[0]]);
  const timestamp = Number(row[timestampColumns[0]]);
  if (!address || isNaN(timestamp)) return null;

  const nearby = allRows.filter(r => {
    if (String(r[addressColumns[0]]) !== address) return false;
    return Math.abs(Number(r[timestampColumns[0]]) - timestamp) <= 60;
  });

  if (nearby.length >= 5) {
    return {
      signal: 'HIGH_FREQUENCY',
      confidence: 'high',
      evidence: `${nearby.length} transactions within 60 seconds from same address`,
    };
  }
  if (nearby.length >= 3) {
    return {
      signal: 'HIGH_FREQUENCY',
      confidence: 'medium',
      evidence: `${nearby.length} transactions within 60 seconds from same address`,
    };
  }
  return null;
}

// ── SINYAL 2: WASH TRADING ────────────────────────────────────────────────
// A→B ve B→A işlemleri toplamda 5+ → kesin wash trading
function detectWashTrading(
  row: RawRow,
  allRows: RawRow[],
  addressColumns: string[]
): SignalDetail | null {
  if (addressColumns.length < 2) return null;

  const from = String(row[addressColumns[0]]);
  const to = String(row[addressColumns[1]]);
  if (!from || !to) return null;

  const oneWay = allRows.filter(r =>
    String(r[addressColumns[0]]) === from &&
    String(r[addressColumns[1]]) === to
  ).length;

  const reverse = allRows.filter(r =>
    String(r[addressColumns[0]]) === to &&
    String(r[addressColumns[1]]) === from
  ).length;

  const total = oneWay + reverse;

  if (total >= 8) {
    return {
      signal: 'WASH_TRADING',
      confidence: 'high',
      evidence: `${oneWay} forward + ${reverse} reverse transactions between same pair (total: ${total})`,
    };
  }
  if (total >= 4) {
    return {
      signal: 'WASH_TRADING',
      confidence: 'medium',
      evidence: `${oneWay} forward + ${reverse} reverse transactions between same pair (total: ${total})`,
    };
  }
  return null;
}

// ── SINYAL 3: SYBIL CLUSTER ───────────────────────────────────────────────
// Bir adresin işlemlerinin %80'den fazlası aynı küçük grupla → izole bot kümesi
function detectSybilCluster(
  row: RawRow,
  allRows: RawRow[],
  addressColumns: string[]
): SignalDetail | null {
  if (addressColumns.length < 2) return null;

  const address = String(row[addressColumns[0]]);
  if (!address) return null;

  // Bu adresin tüm işlemleri
  const myTxs = allRows.filter(r =>
    String(r[addressColumns[0]]) === address ||
    String(r[addressColumns[1]]) === address
  );

  // En az 10 işlem yoksa değerlendirme yapma
  if (myTxs.length < 10) return null;

  // Etkileşime girdiği unique adresler
  const counterparties = new Set<string>();
  for (const r of myTxs) {
    const other = String(r[addressColumns[0]]) === address
      ? String(r[addressColumns[1]])
      : String(r[addressColumns[0]]);
    counterparties.add(other);
  }

  // Her counterparty ile kaç işlem yapılmış
  const counterpartyTxCounts = Array.from(counterparties).map(cp => ({
    address: cp,
    count: myTxs.filter(r =>
      String(r[addressColumns[0]]) === cp ||
      String(r[addressColumns[1]]) === cp
    ).length,
  }));

  // En çok işlem yapılan 3 adresle kaç işlem var?
  counterpartyTxCounts.sort((a, b) => b.count - a.count);
  const top3Count = counterpartyTxCounts.slice(0, 3).reduce((s, x) => s + x.count, 0);
  const concentration = top3Count / myTxs.length;

  // İşlemlerin %80'den fazlası 3 adresle yapılıyorsa ve unique counterparty 5 veya altındaysa
  if (concentration >= 0.8 && counterparties.size <= 5) {
    return {
      signal: 'SYBIL_CLUSTER',
      confidence: 'high',
      evidence: `${Math.round(concentration * 100)}% of transactions with only ${counterparties.size} counterparties`,
    };
  }
  if (concentration >= 0.7 && counterparties.size <= 8) {
    return {
      signal: 'SYBIL_CLUSTER',
      confidence: 'medium',
      evidence: `${Math.round(concentration * 100)}% of transactions with only ${counterparties.size} counterparties`,
    };
  }
  return null;
}

// ── SINYAL 4: ADRES YAŞI ─────────────────────────────────────────────────
// Çok kısa sürede çok yoğun işlem yapan yeni adres
function detectAddressAge(
  row: RawRow,
  allRows: RawRow[],
  addressColumns: string[],
  timestampColumns: string[]
): SignalDetail | null {
  if (addressColumns.length === 0 || timestampColumns.length === 0) return null;

  const address = String(row[addressColumns[0]]);
  const timestamps = allRows
    .filter(r => String(r[addressColumns[0]]) === address)
    .map(r => Number(r[timestampColumns[0]]))
    .filter(t => !isNaN(t))
    .sort((a, b) => a - b);

  if (timestamps.length < 5) return null;

  const ageSeconds = timestamps[timestamps.length - 1] - timestamps[0];

  if (ageSeconds < 300 && timestamps.length >= 5) {
    return {
      signal: 'ADDRESS_AGE',
      confidence: 'high',
      evidence: `${timestamps.length} transactions in ${ageSeconds}s — new address with intense activity`,
    };
  }
  if (ageSeconds < 3600 && timestamps.length >= 10) {
    return {
      signal: 'ADDRESS_AGE',
      confidence: 'medium',
      evidence: `${timestamps.length} transactions in ${Math.round(ageSeconds / 60)}min`,
    };
  }
  return null;
}

// ── KARAR MOTORU ──────────────────────────────────────────────────────────
// Sinyallere bakarak label üretir
// 1+ high confidence sinyal → bot
// Sadece medium sinyal(ler) → suspicious
// Hiç sinyal yok → clean
function classify(signals: SignalDetail[]): 'clean' | 'suspicious' | 'bot' {
  if (signals.length === 0) return 'clean';
  const hasHigh = signals.some(s => s.confidence === 'high');
  if (hasHigh) return 'bot';
  return 'suspicious';
}

// ── ANA FONKSİYON ─────────────────────────────────────────────────────────
export function detectBots(
  rows: RawRow[],
  columns: ColumnDefinition[]
): BotDetectionResult {
  const addressColumns = columns.filter(c => c.type === 'address').map(c => c.name);
  const amountColumns = columns.filter(c => c.type === 'amount').map(c => c.name);
  const timestampColumns = columns.filter(c => c.type === 'timestamp').map(c => c.name);

  const warnings: BotDetectionWarnings = {
    noAddressColumn: addressColumns.length === 0,
    noAmountColumn: amountColumns.length === 0,
    noTimestampColumn: timestampColumns.length === 0,
  };

  if (warnings.noAddressColumn) {
    console.warn('[Distill] Warning: No address column — most bot checks disabled.');
  }
  if (warnings.noTimestampColumn) {
    console.warn('[Distill] Warning: No timestamp column — frequency and age checks disabled.');
  }

  const results = rows.map(row => {
    const signals: SignalDetail[] = [];

    const hf = detectHighFrequency(row, rows, addressColumns, timestampColumns);
    if (hf) signals.push(hf);

    const wt = detectWashTrading(row, rows, addressColumns);
    if (wt) signals.push(wt);

    const sc = detectSybilCluster(row, rows, addressColumns);
    if (sc) signals.push(sc);

    const aa = detectAddressAge(row, rows, addressColumns, timestampColumns);
    if (aa) signals.push(aa);

    const classification: BotClassification = {
      label: classify(signals),
      signals,
    };

    return { row, classification };
  });

  const summary = {
    total: results.length,
    clean: results.filter(r => r.classification.label === 'clean').length,
    suspicious: results.filter(r => r.classification.label === 'suspicious').length,
    bot: results.filter(r => r.classification.label === 'bot').length,
  };

  return { rows: results, summary, warnings };
}