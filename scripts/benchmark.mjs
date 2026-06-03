import { mkdir, writeFile } from 'node:fs/promises';
import { formatPercent, summarizeBenchmarkCases } from '../src/benchmark.js';

const summary = summarizeBenchmarkCases();
const report = {
  generatedAt: new Date().toISOString(),
  averageWer: summary.averageWer,
  averageDer: summary.averageDer,
  totalReferenceWords: summary.totalReferenceWords,
  totalReferenceDurationMs: summary.totalReferenceDurationMs,
  results: summary.results.map(({ id, name, metrics }) => ({ id, name, metrics })),
};

await mkdir('benchmark-results', { recursive: true });
await writeFile('benchmark-results/latest.json', JSON.stringify(report, null, 2));

console.log('Roma AI self benchmark fixtures');
console.log(`Average WER: ${formatPercent(summary.averageWer)} over ${summary.totalReferenceWords} reference words`);
console.log(`Average DER: ${formatPercent(summary.averageDer)} over ${(summary.totalReferenceDurationMs / 1000).toFixed(1)} reference seconds`);
console.log('Report: benchmark-results/latest.json');
console.log('');

for (const result of summary.results) {
  const { metrics } = result;
  console.log(`${result.name}`);
  console.log(`  WER: ${formatPercent(metrics.wer)} (${metrics.wordEdits.substitutions} substitutions, ${metrics.wordEdits.insertions} insertions, ${metrics.wordEdits.deletions} deletions)`);
  console.log(`  CER: ${formatPercent(metrics.cer)}`);
  console.log(`  DER: ${formatPercent(metrics.diarization.der)} (${Math.round(metrics.diarization.missedSpeechMs)}ms miss, ${Math.round(metrics.diarization.falseAlarmMs)}ms false alarm, ${Math.round(metrics.diarization.speakerConfusionMs)}ms confusion)`);
  console.log(`  Accuracy: ${formatPercent(Math.max(0, metrics.accuracy))}`);
  console.log(`  RTF: ${metrics.realTimeFactor === null ? 'n/a' : metrics.realTimeFactor.toFixed(2)}`);
}
