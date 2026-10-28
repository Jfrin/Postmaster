export interface EvalRow {
  expected: string;
  predicted: string;
}

export interface EvalReport {
  total: number;
  correct: number;
  accuracy: number;
  confusion: Record<string, Record<string, number>>; // expected -> predicted -> count
}

export function evaluate(rows: EvalRow[]): EvalReport {
  const confusion: EvalReport['confusion'] = {};
  let correct = 0;
  for (const { expected, predicted } of rows) {
    const row = (confusion[expected] ??= {});
    row[predicted] = (row[predicted] ?? 0) + 1;
    if (expected === predicted) correct++;
  }
  return {
    total: rows.length,
    correct,
    accuracy: rows.length ? correct / rows.length : 0,
    confusion,
  };
}
