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

// ── YENİ: Hybrid Cascade (v3 LightGBM) çıktısı ─────────────────────────────
// Per-transaction ML scoring sonucu. Mevcut clean/suspicious/bot bölümlemesini
// DEĞİŞTİRMEZ — tamamen ek (additive) metadata. `rows` girdideki satır sırasına
// (normalizeInput sırası = girdi sırası) göre hizalıdır.
export type ScoringMethod = "rule_only" | "cascade";

export interface CascadeRowResult {
  index: number;             // normalize edilmiş girdi satır indeksi
  rule_score: number;        // existing_algo_score (0–1) — meta-feature / gate
  ml_score: number | null;   // P(bot) 0–1, rule_only ise null
  scoring_method: ScoringMethod;
  is_bot: boolean;           // bu satır için cascade kararı
}

export interface CascadeOutput {
  enabled: boolean;          // ML modeli yüklendi mi (false → her şey rule_only)
  ml_threshold: number;      // BOT eşiği (P(bot) >=), 0.7
  scoring_method_counts: { rule_only: number; cascade: number };
  ml_bot_count: number;      // cascade ile BOT işaretlenen satır sayısı
  ml_human_count: number;    // cascade ile HUMAN işaretlenen satır sayısı
  rows: CascadeRowResult[];
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
  // Hybrid cascade ML scoring (additive — mevcut alanlar değişmedi).
  cascade?: CascadeOutput;
}