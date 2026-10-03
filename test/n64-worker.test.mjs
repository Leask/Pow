import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';

test('N64 browser worker transfers video/audio and rejects stale epochs', async (t) => {
    const url = new URL('../web/n64-worker.mjs', import.meta.url).href;
    const source = `
        import { parentPort } from 'node:worker_threads';
        globalThis.self = {
            postMessage: (message, transfer) => parentPort.postMessage(message, transfer),
        };
        await import(${JSON.stringify(url)});
        parentPort.on('message', data => self.onmessage({ data }));
        parentPort.postMessage({ type: 'ready' });
    `;
    const worker = new Worker(
        new URL(`data:text/javascript,${encodeURIComponent(source)}`),
    );
    t.after(() => worker.terminate());
    await once(worker, 'message');
    const rom = new Uint8Array(8192);
    rom.set([0x80, 0x37, 0x12, 0x40]);
    const view = new DataView(rom.buffer);
    view.setUint32(8, 0x80000400);
    view.setUint32(0x1000, 0x1000ffff);
    rom[0x3e] = 0x45;
    worker.postMessage({ type: 'load', epoch: 1, rom, sampleRate: 44100 });
    worker.postMessage({ type: 'step', epoch: 1 });
    const [frame] = await once(worker, 'message');
    assert.equal(frame.type, 'frame');
    assert.equal(frame.state.frameCount, 1);
    assert.equal(frame.pixels.length, 320 * 240);
    assert.equal(frame.audio.length, 1470);
    worker.postMessage({ type: 'pause', epoch: 2 });
    const [paused] = await once(worker, 'message');
    assert.equal(paused.epoch, 2);
    assert.equal(paused.audio.length, 0);
    worker.postMessage({ type: 'step', epoch: 1 });
    worker.postMessage({ type: 'step', epoch: 2 });
    const [next] = await once(worker, 'message');
    assert.equal(next.epoch, 2);
    assert.equal(next.state.frameCount, 2);
});
