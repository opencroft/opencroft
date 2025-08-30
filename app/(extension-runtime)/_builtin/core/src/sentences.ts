const SENTENCE_BOUNDARY = /[.!?。！？\n]/;

export interface SentenceAccumulator {
  buf: string;
}

export function createSentenceAccumulator(): SentenceAccumulator {
  return { buf: '' };
}

export function takeSentences(acc: SentenceAccumulator): string[] {
  const out: string[] = [];
  while (true) {
    let idx = -1;
    for (let i = 0; i < acc.buf.length; i++) {
      if (SENTENCE_BOUNDARY.test(acc.buf[i])) {
        idx = i;
        break;
      }
    }
    if (idx === -1) {
      return out;
    }
    const sentence = acc.buf.slice(0, idx + 1).trim();
    acc.buf = acc.buf.slice(idx + 1);
    if (sentence) {
      out.push(sentence);
    }
  }
}

export function flushAccumulator(acc: SentenceAccumulator): string {
  const rest = acc.buf.trim();
  acc.buf = '';
  return rest;
}
