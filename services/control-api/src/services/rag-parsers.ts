import { load as loadHtml } from 'cheerio';
import AdmZip from 'adm-zip';

export class UnsupportedFileTypeError extends Error {
  constructor(contentType: string) {
    super(`Unsupported file type: ${contentType}`);
    this.name = 'UnsupportedFileTypeError';
  }
}

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

const SUPPORTED_CONTENT_TYPES = new Set([
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

export function isSupportedContentType(contentType: string): boolean {
  return SUPPORTED_CONTENT_TYPES.has(contentType);
}

/**
 * Parse a document buffer into plain text based on its content type.
 */
export async function parseDocument(buffer: Buffer, contentType: string): Promise<string> {
  if (!isSupportedContentType(contentType)) {
    throw new UnsupportedFileTypeError(contentType);
  }

  try {
    switch (contentType) {
      case 'text/plain':
      case 'text/markdown':
      case 'text/csv':
        return buffer.toString('utf-8');

      case 'text/html':
        return parseHtml(buffer);

      case 'application/pdf':
        return parsePdf(buffer);

      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        return parseDocx(buffer);

      case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
        return parseXlsx(buffer);

      case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
        return parsePptx(buffer);

      default:
        throw new UnsupportedFileTypeError(contentType);
    }
  } catch (error) {
    if (error instanceof UnsupportedFileTypeError) throw error;
    throw new ParseError(
      `Failed to parse ${contentType}: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

function parseHtml(buffer: Buffer): string {
  const $ = loadHtml(buffer.toString('utf-8'));
  $('script, style, noscript').remove();
  const text = $('body').text() || $.root().text();
  return text.replace(/\s+/g, ' ').trim();
}

async function parsePdf(buffer: Buffer): Promise<string> {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  const result = await parser.getText();
  const text = result.text;
  await parser.destroy();
  return text;
}

async function parseDocx(buffer: Buffer): Promise<string> {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

async function parseXlsx(buffer: Buffer): Promise<string> {
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheets: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const csv = XLSX.utils.sheet_to_csv(sheet);
    if (csv.trim()) {
      sheets.push(`[Sheet: ${sheetName}]\n${csv}`);
    }
  }

  return sheets.join('\n\n');
}

function parsePptx(buffer: Buffer): string {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  const slides: { num: number; text: string }[] = [];

  for (const entry of entries) {
    const match = entry.entryName.match(/^ppt\/slides\/slide(\d+)\.xml$/);
    if (!match) continue;

    const xml = entry.getData().toString('utf-8');
    // Extract text from <a:t> tags (PowerPoint text run elements)
    const textParts = xml.match(/<a:t>([^<]*)<\/a:t>/g) || [];
    const slideText = textParts
      .map(m => m.replace(/<\/?a:t>/g, ''))
      .join(' ')
      .trim();

    if (slideText) {
      slides.push({ num: parseInt(match[1]), text: slideText });
    }
  }

  slides.sort((a, b) => a.num - b.num);
  return slides.map(s => `[Slide ${s.num}]\n${s.text}`).join('\n\n');
}
