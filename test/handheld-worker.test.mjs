import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { crc16 } from '../src/core/nds/rom.mjs';

test('GB browser worker latches short taps and transfers stereo once', async (t) => {
    const url = new URL('../web/n64-worker.mjs', import.meta.url).href;
    const source = `
        import { parentPort } from 'node:worker_threads';
        globalThis.self = { postMessage: (data, transfer) =>
            parentPort.postMessage(data, transfer) };
        await import(${JSON.stringify(url)});
        parentPort.on('message', data => self.onmessage({ data }));
        parentPort.postMessage({ type: 'ready' });
    `;
    const worker = new Worker(
        new URL(`data:text/javascript,${encodeURIComponent(source)}`),
    );
    t.after(() => worker.terminate());
    await once(worker, 'message');
    const rom = new Uint8Array(32768);
    rom.set(
        Buffer.from(
            'ceed6666cc0d000b03730083000c000d0008111f8889000edccc6ee6ddddd999bbbb67636e0eecccdddc999fbbb9333e',
            'hex',
        ),
        0x104,
    );
    rom.set([0xc3, 0x50, 1], 0x100);
    // Poll Start, then trigger channel 2 and wait. No external ROM required.
    rom.set(
        [
            0x3e, 0x10, 0xe0, 0, 0xf0, 0, 0xe6, 8, 0x20, 0xfa, 0x3e, 0xf0, 0xe0,
            0x17, 0x3e, 0x87, 0xe0, 0x19, 0x18, 0xfe,
        ],
        0x150,
    );
    let check = 0;
    for (let i = 0x134; i <= 0x14c; i += 1) check = (check - rom[i] - 1) & 255;
    rom[0x14d] = check;
    worker.postMessage({
        type: 'load',
        system: 'gb',
        epoch: 1,
        rom,
        sampleRate: 44100,
    });
    worker.postMessage({ type: 'step', epoch: 1 });
    const [before] = await once(worker, 'message');
    assert.equal(before.type, 'frame');
    assert.equal(before.pixels.length, 160 * 144);
    assert.ok(before.audio.length >= 1474 && before.audio.length <= 1478);
    assert.ok(before.audio.every((value) => value === 0));
    worker.postMessage({
        type: 'button',
        button: 'START',
        pressed: true,
        epoch: 1,
    });
    worker.postMessage({
        type: 'button',
        button: 'START',
        pressed: false,
        epoch: 1,
    });
    worker.postMessage({ type: 'step', epoch: 1 });
    const [after] = await once(worker, 'message');
    assert.equal(after.type, 'frame');
    assert.ok(after.audio.some((value) => Math.abs(value) > 0.01));
    assert.ok(after.audio.length >= 1474 && after.audio.length <= 1478);
});

test('DS worker preserves a quick touch across frames and clears it on pause', async (t) => {
    const url = new URL('../web/n64-worker.mjs', import.meta.url).href;
    const source = `
        import { parentPort } from 'node:worker_threads';
        globalThis.self = { postMessage: (data, transfer) =>
            parentPort.postMessage(data, transfer) };
        await import(${JSON.stringify(url)});
        parentPort.on('message', data => self.onmessage({ data }));
        parentPort.postMessage({ type: 'ready' });
    `;
    const worker = new Worker(
        new URL(`data:text/javascript,${encodeURIComponent(source)}`),
    );
    t.after(() => worker.terminate());
    await once(worker, 'message');
    const rom = new Uint8Array(4096),
        view = new DataView(rom.buffer);
    [0x200, 0x02000000, 0x02000000, 0x3c].forEach((v, i) =>
        view.setUint32(0x20 + i * 4, v, true),
    );
    [0x300, 0x03800000, 0x03800000, 4].forEach((v, i) =>
        view.setUint32(0x30 + i * 4, v, true),
    );
    // Poll PENIRQ and expose it as a red/green backdrop on the main LCD.
    [
        0xe59f0028, 0xe3a01801, 0xe5801000, 0xe59f2020, 0xe59f3020, 0xe1d210b0,
        0xe3110040, 0x03a0101f, 0x13a01e3e, 0xe1c310b0, 0xeafffff9, 0,
        0x04000000, 0x04000136, 0x05000000,
    ].forEach((v, i) => view.setUint32(0x200 + i * 4, v, true));
    view.setUint32(0x300, 0xeafffffe, true);
    view.setUint16(0x15e, crc16(rom, 0, 0x15e), true);
    worker.postMessage({
        type: 'load',
        system: 'nds',
        epoch: 1,
        rom,
        sampleRate: 44100,
    });
    const step = async () => {
        worker.postMessage({ type: 'step', epoch: 1 });
        const [result] = await once(worker, 'message');
        assert.equal(result.type, 'frame');
        return result;
    };
    const before = await step();
    assert.equal(before.pixels.length, 256 * 384);
    assert.equal(before.pixels[0], 0xff00ff00);
    worker.postMessage({ type: 'touch', epoch: 1, x: 50, y: 60, down: true });
    worker.postMessage({ type: 'touch', epoch: 1, x: 50, y: 60, down: false });
    assert.equal((await step()).pixels[0], 0xffff0000);
    assert.equal((await step()).pixels[0], 0xffff0000);
    assert.equal((await step()).pixels[0], 0xffff0000);
    assert.equal((await step()).pixels[0], 0xff00ff00);
    worker.postMessage({ type: 'touch', epoch: 1, x: 50, y: 60, down: true });
    worker.postMessage({ type: 'pause', epoch: 2 });
    await once(worker, 'message');
    worker.postMessage({ type: 'step', epoch: 2 });
    const [after] = await once(worker, 'message');
    assert.equal(after.type, 'frame');
    assert.equal(after.pixels[0], 0xff00ff00);
});
