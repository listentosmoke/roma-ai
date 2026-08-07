import test from 'node:test';
import assert from 'node:assert/strict';
import { downsample, toPcm16, TARGET_SAMPLE_RATE } from '../src/audio.js';

test('downsamples to 16 kHz and is a no-op at the target rate', () => {
  const input = new Float32Array(48000);
  for (let index = 0; index < input.length; index += 1) input[index] = Math.sin(index / 10);
  assert.equal(downsample(input, 48000).length, TARGET_SAMPLE_RATE);
  assert.equal(downsample(input, TARGET_SAMPLE_RATE).length, input.length);
});

test('encodes float samples as little-endian PCM16', () => {
  const buffer = toPcm16(Float32Array.from([0, 1, -1, 0.5]));
  const view = new DataView(buffer);
  assert.equal(buffer.byteLength, 8);
  assert.equal(view.getInt16(0, true), 0);
  assert.equal(view.getInt16(2, true), 32767); // +1 → max
  assert.equal(view.getInt16(4, true), -32768); // -1 → min
  assert.ok(Math.abs(view.getInt16(6, true) - 16383) <= 1); // 0.5 → ~half scale
});
