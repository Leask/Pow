import test from 'node:test';
import assert from 'node:assert/strict';
import { N64Bus } from '../src/core/n64/bus.mjs';
import { parseN64Header, normalizeN64ROM } from '../src/core/n64/rom.mjs';
import { createNintendoKernelFromROM } from '../src/index.mjs';

test('N64 ROM detection normalizes all three byte orders without mutating input', () => {
    const canonical = new Uint8Array(4096);
    canonical.set([0x80, 0x37, 0x12, 0x40]);
    new DataView(canonical.buffer).setUint32(8, 0x80000400);
    canonical[0x3e] = 0x45;
    for (const [xor, format] of [
        [0, 'z64'],
        [1, 'v64'],
        [3, 'n64'],
    ]) {
        const bytes = canonical.map((_, i) => canonical[i ^ xor]);
        const before = bytes.slice();
        assert.deepEqual(normalizeN64ROM(bytes).bytes, canonical);
        assert.deepEqual(bytes, before);
        assert.equal(parseN64Header(bytes).format, format);
        assert.equal(createNintendoKernelFromROM(bytes).system, 'n64');
    }
    assert.throws(() => normalizeN64ROM(new Uint8Array(4096)), /signature/);
});

test('N64 MI mask registers use clear/set command bits', () => {
    const bus = new N64Bus(new Uint8Array(4096));
    bus.raiseInterrupt(8);
    assert.equal(bus.interruptPending, false);
    bus.write32(0x0430000c, 0x80);
    assert.equal(bus.interruptPending, true);
    bus.write32(0x04400010, 0);
    assert.equal(bus.interruptPending, false);
    bus.write32(0x0430000c, 0x40);
    assert.equal(bus.miMask, 0);
});

test('N64 SP DMA honors count, skip, alignment and memory bank wrap', () => {
    const bus = new N64Bus(new Uint8Array(4096));
    bus.ram.set(
        Array.from({ length: 64 }, (_, i) => i + 1),
        0x100,
    );
    bus.write32(0x04040000, 0x1ffb);
    bus.write32(0x04040004, 0x103);
    bus.write32(0x04040008, (8 << 20) | (1 << 12) | 7);
    assert.deepEqual(
        [...bus.spMem.slice(0x1ff8, 0x2000)],
        [1, 2, 3, 4, 5, 6, 7, 8],
    );
    assert.deepEqual(
        [...bus.spMem.slice(0x1000, 0x1008)],
        [17, 18, 19, 20, 21, 22, 23, 24],
    );
});

test('N64 SI reads controller buttons and signed stick through PIF DMA', () => {
    const bus = new N64Bus(new Uint8Array(4096));
    bus.controllers[0].setButton('A', true);
    bus.controllers[0].setStick(-65, 70);
    bus.ram.set([1, 4, 1, 0, 0, 0, 0, 0xfe], 0x100);
    bus.write32(0x04800000, 0x100);
    bus.write32(0x04800010, 0x1fc007c0);
    bus.clock(512);
    bus.write32(0x04800018, 0);
    bus.write32(0x04800004, 0x1fc007c0);
    bus.clock(512);
    assert.deepEqual([...bus.ram.slice(0x103, 0x107)], [0x80, 0, 191, 70]);
    assert.equal(bus.miInterrupt & 2, 2);
});

test('N64 AI consumes signed stereo PCM at the programmed DAC rate', () => {
    const output = [];
    const bus = new N64Bus(new Uint8Array(4096), {
        sampleRate: 44100,
        onAudioFrame: (left, right) => output.push([left, right]),
    });
    for (let i = 0; i < 16; i += 4) {
        bus.write16(0x100 + i, 16384);
        bus.write16(0x102 + i, -8192);
    }
    bus.write32(0x04500000, 0x100);
    bus.write32(0x04500010, 1103);
    bus.write32(0x04500008, 1);
    bus.write32(0x04500004, 16);
    bus.clock(20000);
    assert.ok(output.some(([left, right]) => left === 0.5 && right === -0.25));
    assert.equal(bus.audio.completedBuffers, 1);
    assert.equal(bus.miInterrupt & 4, 4);
    assert.equal(bus.audio.remaining, 0);
});

test('N64 sample deadlines do not drift with instruction-sized clock steps', () => {
    const bus = new N64Bus(new Uint8Array(4096), { sampleRate: 44100 });
    for (let cycles = 0; cycles < 937500; cycles += 2) bus.clock(2);
    assert.equal(bus.audio.samples, 441);
    assert.equal(bus.audio.samplePhase, 0);
    assert.equal(bus.audioCycles, 937500);
});
