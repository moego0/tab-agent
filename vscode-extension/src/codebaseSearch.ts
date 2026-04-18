import * as fs from 'fs';
import * as path from 'path';

export interface SearchResult {
  file: string;
  lineNumber: number;
  line: string;
  score: number;
}

export async function searchCodebase(
  query: string,
  root: string,
  files: string[],
  maxResults = 20
): Promise<SearchResult[]> {
  const keywords = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);
  if (keywords.length === 0) {
    return [];
  }

  const results: SearchResult[] = [];

  for (const relPath of files) {
    const absPath = path.join(root, relPath);
    let content: string;
    try {
      content = fs.readFileSync(absPath, 'utf-8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      const lineLow = line.toLowerCase();
      const score = keywords.reduce((s, kw) => s + (lineLow.includes(kw) ? 1 : 0), 0);
      if (score > 0) {
        results.push({ file: relPath, lineNumber: idx + 1, line: line.trim(), score });
      }
    });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, maxResults);
}
