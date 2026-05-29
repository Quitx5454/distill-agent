import Anthropic from '@anthropic-ai/sdk';
import { RawRow, ColumnDefinition, SchemaResult } from '../../utils/types';

const MAX_COLUMNS = 20;
const SAMPLE_SIZE = 5;

// Her sütundan örnek değerler çeker
function extractSamples(rows: RawRow[]): Record<string, unknown[]> {
  const samples: Record<string, unknown[]> = {};

  const sampleRows = rows.slice(0, SAMPLE_SIZE);

  for (const row of sampleRows) {
    for (const [key, value] of Object.entries(row)) {
      if (!samples[key]) samples[key] = [];
      samples[key].push(value);
    }
  }

  return samples;
}

// LLM'e gönderilecek prompt'u oluşturur
function buildPrompt(samples: Record<string, unknown[]>): string {
  const columnDescriptions = Object.entries(samples)
    .map(([col, values]) => `- "${col}": [${values.map(v => JSON.stringify(v)).join(', ')}]`)
    .join('\n');

  return `You are analyzing a financial transaction dataset. Below are column names and sample values.

Classify each column and return ONLY a JSON array. No explanation, no markdown, just raw JSON.

Columns and samples:
${columnDescriptions}

For each column return:
{
  "name": "original column name",
  "type": "address" | "amount" | "timestamp" | "token" | "hash" | "unknown",
  "description": "what this column represents",
  "confidence": 0.0 to 1.0
}

Rules:
- address: wallet addresses, contract addresses
- amount: numeric values representing quantities or values
- timestamp: time-related fields
- token: token names, symbols, identifiers
- hash: transaction hashes, block hashes
- unknown: anything that doesn't fit above categories
- If ANY column cannot be classified with confidence > 0.5, still classify it as "unknown"
- Return ALL columns, no exceptions`;
}

// Ana fonksiyon: Ham veriyi alır, sütunları tanımlar
export async function defineSchema(rows: RawRow[]): Promise<SchemaResult> {

  // YENİ SIRALAMA: Önce boş veri kontrolü, sonra sütun sayısı
  // Neden: rows[0] ifadesi dizi boşsa çöker, bu yüzden önce bunu kontrol etmeliyiz
  if (rows.length === 0) {
    return {
      columns: [],
      success: false,
      error: 'Input data is empty.',
    };
  }

  const columnCount = Object.keys(rows[0]).length;
  if (columnCount > MAX_COLUMNS) {
    return {
      columns: [],
      success: false,
      error: `Too many columns: ${columnCount}. Maximum allowed is ${MAX_COLUMNS}.`,
    };
  }

  // YENİ: Sütun sayısı sıfırsa hata ver
  if (columnCount === 0) {
    return {
      columns: [],
      success: false,
      error: 'Input rows have no columns.',
    };
  }

  const samples = extractSamples(rows);
  const prompt = buildPrompt(samples);

  // YENİ: Anthropic API hatasını yakala
  let rawText: string;

  try {
    const client = new Anthropic();

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    rawText = message.content
      .filter(block => block.type === 'text')
      .map(block => (block as { type: 'text'; text: string }).text)
      .join('');

  } catch (err) {
    // İnternet yok, API anahtarı yanlış, kota doldu gibi durumlar buraya düşer
    const message = err instanceof Error ? err.message : 'Unknown API error.';
    return {
      columns: [],
      success: false,
      error: `Anthropic API error: ${message}`,
    };
  }

  // LLM yanıtını parse et
  let columns: ColumnDefinition[];

  try {
    const cleaned = rawText
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();
    columns = JSON.parse(cleaned);
  } catch {
    return {
      columns: [],
      success: false,
      error: `LLM returned invalid JSON: ${rawText.slice(0, 200)}`,
    };
  }

  // Tüm sütunlar tanımlandı mı kontrol et
  const inputColumns = Object.keys(samples);
  const outputColumns = columns.map(c => c.name);
  const missingColumns = inputColumns.filter(col => !outputColumns.includes(col));

  if (missingColumns.length > 0) {
    return {
      columns: [],
      success: false,
      error: `These columns could not be identified: ${missingColumns.join(', ')}`,
    };
  }


  return {
    columns,
    success: true,
  };
}