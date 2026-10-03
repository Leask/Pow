import test from 'node:test';
import assert from 'node:assert/strict';
import { GBABus } from '../src/core/gba/bus.mjs';
import { GBAKernel } from '../src/core/gba/gba-kernel.mjs';
import { NDSMemory, NDSBus } from '../src/core/nds/bus.mjs';
import { NDSKernel } from '../src/core/nds/nds-kernel.mjs';
import { NDSPPU } from '../src/core/nds/ppu.mjs';
import { crc16 } from '../src/core/nds/rom.mjs';
import { detectNintendoSystem } from '../src/core/system-detect.mjs';
import { biosService } from '../src/shared/nintendo/arm-bios.mjs';

function makeGBA() {
    const rom = new Uint8Array(0x1000),
        view = new DataView(rom.buffer);
    view.setUint32(0, 0xea00002e, true); // Branch past the cartridge header.
    view.setUint32(0xc0, 0xeafffffe, true);
    rom[4] = 0x24;
    rom[5] = 255;
    rom[0xb2] = 0x96;
    let check = 0;
    for (let i = 0xa0; i <= 0xbc; i += 1) check += rom[i];
    rom[0xbd] = -check - 0x19;
    return rom;
}
function makeNDS() {
    const rom = new Uint8Array(4096),
        view = new DataView(rom.buffer);
    [0x200, 0x02000000, 0x02000000, 4].forEach((v, i) =>
        view.setUint32(0x20 + i * 4, v, true),
    );
    [0x204, 0x03800000, 0x03800000, 4].forEach((v, i) =>
        view.setUint32(0x30 + i * 4, v, true),
    );
    view.setUint32(0x200, 0xeafffffe, true);
    view.setUint32(0x204, 0xeafffffe, true);
    view.setUint16(0x15e, crc16(rom, 0, 0x15e), true);
    return rom;
}
function dsMemory() {
    const m = new NDSMemory(makeNDS());
    m.buses = [new NDSBus(m, 0), new NDSBus(m, 1)];
    return m;
}

test('GBA DMA fill, VBlank transfer and hardware read-only counters', () => {
    const b = new GBABus(makeGBA());
    b.write32(0x02000000, 0x7c007c00);
    b.write32(0x040000d4, 0x02000000);
    b.write32(0x040000d8, 0x06000000);
    b.write32(0x040000dc, 0x85000002);
    assert.equal(b.read32(0x06000004), 0x7c007c00);
    assert.equal(b.reg(0xde) & 0x8000, 0);
    b.write32(0x040000dc, 0xd5000002);
    b.write32(0x06000000, 0);
    assert.equal(b.read32(0x06000000), 0);
    b.eventDMA(1);
    assert.equal(b.read32(0x06000000), 0x7c007c00);
    assert.ok(b.reg(0x202) & 0x800);
    b.write16(0x04000006, 100);
    assert.equal(b.read16(0x04000006), 0);
});

test('GBA timer cascade and stereo direct-sound FIFO routing', () => {
    const samples = [];
    const b = new GBABus(makeGBA(), {
        onAudioFrame: (l, r) => samples.push([l, r]),
    });
    b.write16(0x04000084, 128);
    b.write16(0x04000082, 0x0204); // FIFO A at full volume, left only.
    b.write32(0x040000a0, 0x40404040);
    b.write16(0x04000100, 0xfffc);
    b.write16(0x04000102, 0x80);
    b.write16(0x04000104, 0xffff);
    b.write16(0x04000106, 0xc4);
    b.clockTimers(4);
    assert.equal(b.pcm[0], 64);
    assert.ok(b.reg(0x202) & 16);
    b.apu.clock(100);
    assert.ok(samples.some(([l, r]) => l > 0.2 && r === 0));
});

test('GBA mode 3 scanout and byte-write restrictions', () => {
    const b = new GBABus(makeGBA());
    b.write16(0x04000000, 0x0403);
    b.write16(0x04000020, 256);
    b.write16(0x04000026, 256);
    b.write16(0x06000000, 31);
    b.ppu.renderLine(0);
    assert.equal(b.ppu.frameBuffer[0], 0xffff0000);
    b.write8(0x06000002, 0x12);
    assert.equal(b.read16(0x06000002), 0x1212);
    b.write8(0x07000000, 0xff);
    assert.equal(b.read16(0x07000000), 0);
});

test('BIOS LZ77 copies overlapping backreferences and signed division', () => {
    const b = new GBABus(makeGBA());
    const cpu = { r: new Uint32Array(16) };
    b.ewram.set([0x10, 6, 0, 0, 0x10, 65, 66, 67, 0, 2]);
    cpu.r.set([0x02000000, 0x03000000]);
    biosService(0x11, cpu, b);
    assert.deepEqual([...b.iwram.subarray(0, 6)], [65, 66, 67, 65, 66, 67]);
    cpu.r.set([-7, 3]);
    biosService(6, cpu, b);
    assert.equal(cpu.r[0] | 0, -2);
    assert.equal(cpu.r[1] | 0, -1);
});

test('DS IPC FIFO request/acknowledge, full/empty status and IRQs', () => {
    const m = dsMemory(),
        [a, b] = m.buses;
    a.write16(0x04000184, 0x8004);
    b.write16(0x04000184, 0x8400);
    a.write32(0x04000188, 0xdeadbeef);
    assert.ok(b.reg32(0x214) & (1 << 18));
    assert.equal(b.fifoStatus() & 256, 0);
    assert.equal(b.read32(0x04100000), 0xdeadbeef);
    assert.ok(a.reg32(0x214) & (1 << 17));
    assert.ok(b.fifoStatus() & 256);
    for (let i = 0; i < 17; i += 1) a.write32(0x04000188, i);
    assert.equal(m.fifos[1].length, 16);
    assert.ok(a.fifoStatus() & 0x4000);
});

test('DS VRAM/WRAM remapping does not lose physical bank contents', () => {
    const m = dsMemory(),
        [a, b] = m.buses;
    a.write8(0x04000240, 0x81);
    a.write16(0x06000000, 0x1234);
    a.write8(0x04000240, 0x80);
    assert.equal(a.read16(0x06800000), 0x1234);
    a.write8(0x04000242, 0x82);
    b.write16(0x06000000, 0xabcd);
    a.write8(0x04000242, 0x84);
    assert.equal(a.read16(0x06200000), 0xabcd);
    a.write8(0x04000247, 1);
    a.write16(0x03000000, 0x5555);
    b.write16(0x03000000, 0xaaaa);
    assert.equal(m.sharedWRAM[0], 0xaa);
    assert.equal(m.sharedWRAM[16384], 0x55);
});

test('DS 3D display fails explicitly rather than rendering it as 2D tiles', () => {
    const m = dsMemory(),
        ppu = new NDSPPU(m);
    m.buses[0].setReg32(0, 0x00010108);
    assert.throws(() => ppu.renderLine(0), /3D BG0/);
    m.buses[0].setReg32(0, 0x00020108);
    assert.doesNotThrow(() => ppu.renderLine(0));
});

test('DS cartridge repeat DMA consumes an entire 512-byte ready-word block', () => {
    const m = dsMemory(),
        b = m.buses[0];
    for (let i = 0; i < 512; i += 1) m.rom[0x400 + i] = i & 255;
    b.write32(0x040000b0, 0x04100010);
    b.write32(0x040000b4, 0x02001000);
    b.write32(0x040000b8, 0xaf000001);
    b.io.set([0xb7, 0, 0, 4, 0, 0, 0, 0], 0x1a8);
    b.write16(0x040001a0, 0x4000);
    b.write32(0x040001a4, 0x81000000);
    assert.equal(b.card.remaining, 0);
    assert.deepEqual(
        [...m.ram.subarray(0x1000, 0x1200)],
        [...m.rom.subarray(0x400, 0x600)],
    );
    assert.equal(b.reg32(0x1a4) & 0x80000000, 0);
    assert.ok(b.reg32(0x214) & (1 << 19));
});

test('DS touchscreen accepts successive ADC commands with chip select held', () => {
    const m = dsMemory(),
        b = m.buses[1];
    m.touch = { down: true, x: 254, y: 0 };
    b.write16(0x040001c0, 0x8a00);
    const sample = (command) => {
        b.write8(0x040001c2, command);
        b.write8(0x040001c2, 0);
        const high = b.read8(0x040001c2);
        b.write8(0x040001c2, 0);
        return (high << 5) | (b.read8(0x040001c2) >>> 3);
    };
    assert.equal(sample(0xd0), 0xe00);
    assert.equal(sample(0x90), 0x200);
    assert.equal(sample(0xb0), 0x700);
    m.touch.x = 55;
    b.write8(0x040001c2, 0xd1);
    b.write8(0x040001c2, 0);
    const high = b.read8(0x040001c2);
    b.write8(0x040001c2, 0x91);
    assert.equal(
        (high << 5) | (b.read8(0x040001c2) >>> 3),
        0x200 + Math.round((55 / 254) * 0xc00),
    );
});

test('GBA/NDS detection, deterministic frame/audio replay and malformed states', () => {
    for (const [Kernel, data, system] of [
        [GBAKernel, makeGBA(), 'gba'],
        [NDSKernel, makeNDS(), 'nds'],
    ]) {
        assert.equal(detectNintendoSystem(data), system);
        assert.throws(
            () => new Kernel({ sampleRate: 0 }).loadROMBuffer(data),
            /Invalid sample rate/,
        );
        const audio = [],
            kernel = new Kernel({ onAudioFrame: (l, r) => audio.push(l, r) });
        kernel.loadROMBuffer(data);
        kernel.runFrame();
        const state = kernel.saveState();
        kernel.runFrame();
        const expected = kernel.saveState();
        kernel.loadState(state);
        audio.length = 0;
        kernel.runFrame();
        assert.deepEqual(kernel.saveState(), expected);
        const fresh = new Kernel();
        fresh.loadROMBuffer(data);
        fresh.loadState(state);
        fresh.runFrame();
        assert.deepEqual(fresh.saveState(), expected);
        assert.ok(audio.length > 1000);
        assert.throws(
            () => kernel.loadState({ ...state, identity: 'other' }),
            /mismatch/,
        );
        const invalid = structuredClone(state);
        invalid.devices[0].frameCount = NaN;
        assert.throws(() => kernel.loadState(invalid), /Invalid state number/);
        if (system === 'gba') {
            const invalidAudio = structuredClone(state);
            invalidAudio.devices[2].pcmCap[0] = NaN;
            assert.throws(
                () => kernel.loadState(invalidAudio),
                /Invalid state number/,
            );
        }
        assert.deepEqual(kernel.saveState(), expected);
    }
});
