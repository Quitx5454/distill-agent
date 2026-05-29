// Gelen ham verinin tek bir satırı
export type RawRow = Record<string, unknown>;

// Katman 1 çıktısı
export interface ColumnDefinition {
  name: string;
  type: 'address' | 'amount' | 'timestamp' | 'token' | 'hash' | 'unknown';
  description: string;
  confidence: number;
}

export interface SchemaResult {
  columns: ColumnDefinition[];
  success: boolean;
  error?: string;
}

// ── YENİ: Sinyal tabanlı bot tespiti ──────────────────────────────────────

// Tespit edilen sinyal tipleri
export type BotSignal =
  | 'HIGH_FREQUENCY'   // 60sn içinde 5+ işlem — kesin bot davranışı
  | 'WASH_TRADING'     // A→B + B→A döngüsü — kesin bot davranışı
  | 'SYBIL_CLUSTER'    // Sadece küçük bir grupla işlem, dışarıyla etkileşim yok
  | 'ADDRESS_AGE';     // Yeni adres + yoğun işlem

// Her sinyal için detay
export interface SignalDetail {
  signal: BotSignal;
  confidence: 'high' | 'medium'; // high: kesin sinyal, medium: destekleyici sinyal
  evidence: string;               // Neden bu sinyal tetiklendi
}

// Her işlemin sınıflandırma sonucu
export interface BotClassification {
  label: 'clean' | 'suspicious' | 'bot';
  signals: SignalDetail[];        // Tespit edilen sinyaller (boş olabilir)
}

export interface BotDetectionResult {
  rows: Array<{ row: RawRow; classification: BotClassification }>;
  summary: {
    total: number;
    clean: number;
    suspicious: number;
    bot: number;
  };
  warnings: BotDetectionWarnings;
}

export interface BotDetectionWarnings {
  noAddressColumn: boolean;
  noAmountColumn: boolean;
  noTimestampColumn: boolean;
}

// Katman 3 çıktısı
export interface Features {
  totalVolume: number;        // Bot hariç tüm hacim (temiz + şüpheli)
  cleanVolume: number;        // Sadece temiz işlemler
  suspiciousVolume: number;   // Sadece şüpheli işlemler
  botVolume: number;          // YENİ: filtrelenen bot işlemlerinin hacmi
  volumeConfidence: string;   // Temiz verinin toplama yüzdesi
  uniqueCounterparties: number;
  avgTransactionSize: number;
  peakActivity: string;
  recurringPatterns: string[];
}

// Final çıktı
export interface DistillOutput {
  summary: {
    total_transactions: number;
    bot_filtered: number;
    suspicious: number;
    clean_transactions: number;
    bot_ratio: string;
  };
  warnings: BotDetectionWarnings;
  features: Features;
  clean_data: RawRow[];
  suspicious_data: RawRow[];
}