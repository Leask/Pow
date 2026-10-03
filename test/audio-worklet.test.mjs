import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('audio worklet primes, preserves stereo order, and discards stale-epoch audio', () => {
    let Processor;
    class Base {
        constructor() {
            this.port = { postMessage() {} };
        }
    }
    vm.runInNewContext(
        fs.readFileSync(
            new URL('../web/audio-worklet.mjs', import.meta.url),
            'utf8',
        ),
        {
            AudioWorkletProcessor: Base,
            registerProcessor: (name, type) => {
                Processor = type;
            },
            Float32Array,
        },
    );
    const processor = new Processor();
    const send = (data) => processor.port.onmessage({ data });
    send({ type: 'active', value: true });
    const samples = new Float32Array(4096);
    for (let i = 0; i < 2048; i += 1) {
        samples[i * 2] = i / 2048;
        samples[i * 2 + 1] = -i / 2048;
    }
    send({ type: 'samples', epoch: 0, samples });
    const left = new Float32Array(128);
    const right = new Float32Array(128);
    processor.process([], [[left, right]]);
    assert.equal(left[127], 127 / 2048);
    assert.equal(right[127], -127 / 2048);
    send({ type: 'clear', epoch: 1 });
    send({ type: 'samples', epoch: 0, samples });
    processor.process([], [[left, right]]);
    assert.ok(left.every((value) => value === 0));
    assert.equal(processor.size, 0);
});
