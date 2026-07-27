const BM25_K1 = 1.2;
const BM25_B = 0.75;

export interface LexicalDocument {
  id: number;
  path: string;
  name: string | null;
  text: string;
  startOffset: number;
}

export interface LexicalRank {
  id: number;
  rank: number;
  score: number;
}

function splitIdentifier(value: string): string {
  return value
    .replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, "$1 $2")
    .replace(/([\p{Lu}]+)([\p{Lu}][\p{Ll}])/gu, "$1 $2");
}

/** Terms shared by lexical documents and queries, including identifier parts. */
export function lexicalTerms(value: string): string[] {
  return splitIdentifier(value.normalize("NFKC"))
    .toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}]+/gu)
    ?.filter((term) => term.length > 1 || /^\d+$/.test(term)) ?? [];
}

function weightedTerms(document: LexicalDocument): string[] {
  const path = lexicalTerms(document.path);
  const name = lexicalTerms(document.name ?? "");
  return [
    ...path,
    ...path,
    ...name,
    ...name,
    ...name,
    ...lexicalTerms(document.text),
  ];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Rank positive lexical matches with an in-memory BM25 reference scorer. */
export function rankLexicalDocuments(
  query: string,
  documents: readonly LexicalDocument[],
): LexicalRank[] {
  const terms = [...new Set(lexicalTerms(query))];
  if (terms.length === 0 || documents.length === 0) return [];

  const prepared = documents.map((document) => {
    const tokens = weightedTerms(document);
    const frequencies = new Map<string, number>();
    for (const token of tokens) {
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }
    return { document, frequencies, length: tokens.length };
  });
  const averageLength = prepared.reduce(
    (total, document) => total + document.length,
    0,
  ) / prepared.length;
  const documentFrequency = new Map<string, number>();
  for (const term of terms) {
    documentFrequency.set(
      term,
      prepared.reduce(
        (count, document) => count + (document.frequencies.has(term) ? 1 : 0),
        0,
      ),
    );
  }

  const scored = prepared.flatMap(({ document, frequencies, length }) => {
    let score = 0;
    for (const term of terms) {
      const frequency = frequencies.get(term) ?? 0;
      if (frequency === 0) continue;
      const containing = documentFrequency.get(term)!;
      const inverseDocumentFrequency = Math.log(
        1 + (documents.length - containing + 0.5) / (containing + 0.5),
      );
      const denominator = frequency + BM25_K1 * (
        1 - BM25_B + BM25_B * length / Math.max(averageLength, 1)
      );
      score += inverseDocumentFrequency *
        (frequency * (BM25_K1 + 1) / denominator);
    }
    return score > 0 ? [{ document, score }] : [];
  });

  scored.sort((left, right) =>
    right.score - left.score ||
    compareText(left.document.path, right.document.path) ||
    left.document.startOffset - right.document.startOffset ||
    left.document.id - right.document.id
  );
  return scored.map(({ document, score }, index) => ({
    id: document.id,
    rank: index + 1,
    score,
  }));
}
