import test from 'node:test';
import assert from 'node:assert/strict';
import { SM83 } from '../src/core/gb/cpu-sm83.mjs';
import { GBCartridge } from '../src/core/gb/cartridge.mjs';
import { GBBus } from '../src/core/gb/bus.mjs';
import { GBKernel, GBCKernel } from '../src/core/gb/gb-kernel.mjs';
import { detectNintendoSystem } from '../src/core/system-detect.mjs';

function rom(color = false, banks = 2) {
    const data = new Uint8Array(banks * 16384);
    const logo =
        'ceed6666cc0d000b03730083000c000d0008111f8889000edccc6ee6ddddd999bbbb67636e0eecccdddc999fbbb9333e';
    data.set(Buffer.from(logo, 'hex'), 0x104);
    data.set([0xc3, 0x50, 1], 0x100);
    data.set([0x18, 0xfe], 0x150);
    data[0x143] = color ? 0x80 : 0;
    data[0x147] = banks > 2 ? 3 : 0;
    data[0x149] = banks > 2 ? 3 : 0;
    let check = 0;
    for (let i = 0x134; i <= 0x14c; i += 1) check = (check - data[i] - 1) & 255;
    data[0x14d] = check;
    return data;
}

test('SM83 decimal adjustment, CB bit flags, EI delay and HALT bug', () => {
    const b = new GBBus(new GBCartridge(rom()));
    const cpu = new SM83(b);
    cpu.pc = 0xc000;
    b.wram.set([
        0x3e, 0x09, 0xc6, 0x01, 0x27, 0xcb, 0x7f, 0xfb, 0, 0x76, 0x3e, 0x42,
    ]);
    cpu.step();
    cpu.step();
    cpu.step();
    assert.equal(cpu.r[7], 0x10);
    cpu.step();
    assert.equal(cpu.f, 0xa0);
    cpu.step();
    assert.equal(cpu.ime, false);
    cpu.step();
    assert.equal(cpu.ime, true);
    cpu.ime = false;
    b.ie = b.io[15] = 1;
    cpu.step();
    assert.equal(cpu.haltBug, true);
    cpu.step();
    assert.equal(cpu.r[7], 0x3e);
});

test('MBC1 bank selection and battery RAM are independent of CPU reset', () => {
    const data = rom(false, 64);
    for (let bank = 1; bank < 64; bank += 1) data[bank * 16384] = bank;
    const cart = new GBCartridge(data);
    cart.write(0x2000, 0);
    assert.equal(cart.read(0x4000), 1);
    cart.write(0x4000, 1);
    assert.equal(cart.read(0x4000), 33);
    cart.write(0x6000, 1);
    assert.equal(cart.read(0), 32);
    cart.write(0, 10);
    cart.write(0xa000, 0x55);
    cart.write(0x4000, 2);
    assert.equal(cart.read(0xa000), 255);
    cart.write(0x4000, 1);
    assert.equal(cart.read(0xa000), 0x55);
    cart.reset();
    assert.equal(cart.read(0x4000), 1);
    assert.equal(cart.ram[8192], 0x55);
    assert.equal(cart.header.mapperId, 1);
});

test('timer falling edge, overflow delay and joypad selection interrupt', () => {
    const b = new GBBus(new GBCartridge(rom()));
    b.div = 0;
    b.write(0xff07, 5);
    b.write(0xff05, 255);
    b.write(0xff06, 0x42);
    b.clock(16);
    assert.equal(b.read(0xff05), 0);
    assert.equal(b.io[15] & 4, 0);
    b.clock(4);
    assert.equal(b.read(0xff05), 0x42);
    assert.ok(b.io[15] & 4);
    b.write(0xff00, 0x10);
    b.setButton('START', true);
    assert.equal(b.read(0xff00) & 15, 7);
    assert.ok(b.io[15] & 16);
});

test('CGB palette auto-increment, VRAM bank and HBlank DMA', () => {
    const b = new GBBus(new GBCartridge(rom(true)), { color: true });
    b.write(0xff68, 128);
    b.write(0xff69, 31);
    b.write(0xff69, 0);
    assert.equal(b.io[0x68], 130);
    b.write(0xff4f, 1);
    b.write(0x8000, 0x80);
    assert.equal(b.vram[8192], 128);
    assert.equal(b.vram[0], 0);
    b.wram[0] = 0x5a;
    b.write(0xff51, 0xc0);
    b.write(0xff52, 0);
    b.write(0xff53, 0);
    b.write(0xff54, 0);
    b.write(0xff55, 128);
    b.hblankDMA();
    assert.equal(b.vram[8192], 0x5a);
    assert.equal(b.io[0x55], 255);
    b.write(0xff4f, 0);
    b.vram[0] = 0xff;
    b.bgPalette[2] = 31;
    b.bgPalette[3] = 0;
    b.ppu.renderLine();
    assert.equal(b.ppu.frameBuffer[0], 0xffff0000);
});

test('GB/GBC detection, stereo audio and copied state replay', () => {
    for (const color of [false, true]) {
        const data = rom(color);
        assert.equal(detectNintendoSystem(data), color ? 'gbc' : 'gb');
        const samples = [];
        const kernel = color
            ? new GBCKernel({ onAudioFrame: (l, r) => samples.push(l, r) })
            : new GBKernel({ onAudioFrame: (l, r) => samples.push(l, r) });
        kernel.loadROMBuffer(data);
        if (color) {
            assert.equal(kernel.cpu.pair(0), 0);
            assert.equal(kernel.cpu.pair(1), 0xff56);
            assert.equal(kernel.cpu.pair(2), 0x000d);
        }
        const b = kernel.bus;
        b.write(0xff25, 0x11);
        b.write(0xff11, 0x80);
        b.write(0xff12, 0xf0);
        b.write(0xff13, 0x00);
        b.write(0xff14, 0x87);
        kernel.runFrames(3);
        assert.ok(samples.some((v) => Math.abs(v) > 0.05));
        const state = kernel.saveState();
        const frozen = state.devices[2].wram.slice();
        samples.length = 0;
        kernel.runFrames(2);
        const expected = kernel.saveState(),
            audio = samples.slice();
        kernel.loadState(state);
        samples.length = 0;
        kernel.runFrames(2);
        assert.deepEqual(kernel.saveState(), expected);
        assert.deepEqual(samples, audio);
        assert.deepEqual(state.devices[2].wram, frozen);
    }
});

export { rom as makeGBROM };
