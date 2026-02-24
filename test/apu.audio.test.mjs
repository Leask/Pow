import test from 'node:test';
import assert from 'node:assert/strict';
import { APU } from '../src/core/apu.mjs';

test('APU emits normalized audio samples for an enabled pulse channel', () => {
    const samples = [];
    const apu = new APU({
        sampleRate: 44100,
        onSample: (sample) => {
            samples.push(sample);
        },
    });

    // Pulse 1: duty + volume
    apu.writeRegister(0x4000, 0x9f);
    // Timer low/high
    apu.writeRegister(0x4002, 0xff);
    apu.writeRegister(0x4003, 0x03);
    // Enable pulse 1
    apu.writeRegister(0x4015, 0x01);

    apu.clock(20000);

    assert.ok(samples.length > 0);
    assert.ok(samples.some((sample) => sample !== 0));
    assert.ok(samples.every((sample) => sample <= 1 && sample >= -1));
});
