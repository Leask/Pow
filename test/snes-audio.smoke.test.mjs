import path from 'node:path';
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SNESKernel } from '../src/core/snes/snes-kernel.mjs';

test('SNES kernel emits audible-range audio samples', () => {
    const romPath = path.resolve(process.cwd(), 'Mario World.smc');
    const romData = fs.readFileSync(romPath);
    const samples = [];
    const kernel = new SNESKernel({
        onAudioSample: (sample) => {
            if (samples.length < 200_000) {
                samples.push(sample);
            }
        },
    });

    kernel.loadROMBuffer(romData);
    kernel.runFrames(180);

    const state = kernel.getExecutionState();
    let maxAbs = 0;

    for (let index = 0; index < samples.length; index += 1) {
        const value = Math.abs(samples[index]);

        if (value > maxAbs) {
            maxAbs = value;
        }
    }

    assert.ok(state.audioSampleCount > 0);
    assert.ok(samples.length > 0);
    assert.ok(maxAbs > 0.001);
    assert.ok(maxAbs <= 1);
});
