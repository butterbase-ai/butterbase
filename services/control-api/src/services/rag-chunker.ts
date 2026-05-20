export interface Chunk {
  content: string;
  chunkIndex: number;
  tokenCount: number;
}

export interface ChunkOptions {
  chunkSize: number;   // target chunk size in tokens
  chunkOverlap: number; // overlap between chunks in tokens
}

/**
 * Approximate token count using whitespace splitting.
 * Roughly 1 word ≈ 1.3 tokens for English text.
 */
function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter(w => w.length > 0);
  return Math.ceil(words.length * 1.3);
}

/**
 * Split text into chunks using recursive character text splitting.
 *
 * Strategy:
 * 1. Split by double newlines (paragraphs)
 * 2. If a segment exceeds chunkSize, split by single newlines
 * 3. If still too large, split by sentences
 * 4. If still too large, split by words at token boundaries
 * 5. Apply overlap between chunks
 */
export function chunkText(text: string, options: ChunkOptions): Chunk[] {
  const { chunkSize, chunkOverlap } = options;

  if (!text || text.trim().length === 0) {
    return [];
  }

  const separators = ['\n\n', '\n', '. ', '? ', '! ', '; ', ', ', ' '];
  const segments = recursiveSplit(text, separators, chunkSize);
  return mergeWithOverlap(segments, chunkSize, chunkOverlap);
}

/**
 * Recursively split text into segments that fit within chunkSize tokens.
 */
function recursiveSplit(text: string, separators: string[], chunkSize: number): string[] {
  if (estimateTokens(text) <= chunkSize) {
    return [text.trim()].filter(s => s.length > 0);
  }

  // Try each separator in order of preference
  for (const sep of separators) {
    const parts = text.split(sep);
    if (parts.length <= 1) continue;

    const results: string[] = [];
    let currentPart = '';

    for (const part of parts) {
      const combined = currentPart ? currentPart + sep + part : part;

      if (estimateTokens(combined) <= chunkSize) {
        currentPart = combined;
      } else {
        if (currentPart.trim()) {
          results.push(currentPart.trim());
        }
        // If the single part exceeds chunkSize, recursively split with finer separators
        if (estimateTokens(part) > chunkSize) {
          const finerSeparators = separators.slice(separators.indexOf(sep) + 1);
          if (finerSeparators.length > 0) {
            results.push(...recursiveSplit(part, finerSeparators, chunkSize));
          } else {
            // Last resort: hard split by words
            results.push(...hardSplitByWords(part, chunkSize));
          }
          currentPart = '';
        } else {
          currentPart = part;
        }
      }
    }

    if (currentPart.trim()) {
      results.push(currentPart.trim());
    }

    if (results.length > 0) return results;
  }

  // All separators exhausted — hard split by words
  return hardSplitByWords(text, chunkSize);
}

/**
 * Hard split text into chunks at word boundaries when no separator works.
 */
function hardSplitByWords(text: string, chunkSize: number): string[] {
  const words = text.split(/\s+/);
  const results: string[] = [];
  let current: string[] = [];

  for (const word of words) {
    current.push(word);
    if (estimateTokens(current.join(' ')) >= chunkSize) {
      results.push(current.join(' '));
      current = [];
    }
  }

  if (current.length > 0) {
    results.push(current.join(' '));
  }

  return results.filter(s => s.trim().length > 0);
}

/**
 * Merge segments into chunks with overlap.
 * Adjacent small segments are merged if they fit within chunkSize.
 * Overlap is applied by prepending tokens from the end of the previous chunk.
 */
function mergeWithOverlap(segments: string[], chunkSize: number, overlapTokens: number): Chunk[] {
  if (segments.length === 0) return [];

  // First pass: merge adjacent small segments
  const merged: string[] = [];
  let current = segments[0];

  for (let i = 1; i < segments.length; i++) {
    const combined = current + '\n\n' + segments[i];
    if (estimateTokens(combined) <= chunkSize) {
      current = combined;
    } else {
      merged.push(current);
      current = segments[i];
    }
  }
  merged.push(current);

  // Second pass: apply overlap
  const chunks: Chunk[] = [];
  for (let i = 0; i < merged.length; i++) {
    let content = merged[i];

    // Prepend overlap from previous chunk
    if (i > 0 && overlapTokens > 0) {
      const prevWords = merged[i - 1].split(/\s+/);
      const overlapWordCount = Math.ceil(overlapTokens / 1.3); // convert tokens to approximate words
      const overlapWords = prevWords.slice(-overlapWordCount);
      if (overlapWords.length > 0) {
        content = overlapWords.join(' ') + ' ' + content;
      }
    }

    chunks.push({
      content: content.trim(),
      chunkIndex: i,
      tokenCount: estimateTokens(content),
    });
  }

  return chunks;
}
