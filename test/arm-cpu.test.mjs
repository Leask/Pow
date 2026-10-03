import test from 'node:test';
import assert from 'node:assert/strict';
import { ARMCPU } from '../src/shared/nintendo/arm-cpu.mjs';

function fixture(words = []) {
    const memory = new DataView(new ArrayBuffer(4096));
    words.forEach((op, i) => memory.setUint32(i * 4, op, true));
    const bus = {
        read8: (a) => memory.getUint8(a & 4095),
        read16: (a) => memory.getUint16(a & 4094, true),
        read32: (a) => memory.getUint32(a & 4092, true),
        write8: (a, v) => memory.setUint8(a & 4095, v),
        write16: (a, v) => memory.setUint16(a & 4094, v, true),
        write32: (a, v) => memory.setUint32(a & 4092, v, true),
    };
    return { cpu: new ARMCPU(bus, { entry: 0, v5: true }), bus, memory };
}

test('ARM arithmetic carry/overflow and conditional execution', () => {
    const { cpu } = fixture([0xe2901001, 0x22822001, 0xe2513001]);
    cpu.r[0] = 0xffffffff;
    cpu.step();
    assert.equal(cpu.r[1], 0);
    assert.equal(cpu.cpsr >>> 28, 6);
    cpu.step();
    assert.equal(cpu.r[2], 1);
    cpu.step();
    assert.equal(cpu.r[3], 0xffffffff);
    assert.equal(cpu.cpsr >>> 28, 8);
    cpu.r[0] = 0x7fffffff;
    cpu.pc = 0;
    cpu.step();
    assert.equal(cpu.cpsr >>> 28, 9);
});

test('ARM and Thumb pipeline PCs, BX and BL return addresses', () => {
    const { cpu, memory } = fixture([0xe12fff10]);
    cpu.r[0] = 0x101;
    memory.setUint16(0x100, 0xf000, true);
    memory.setUint16(0x102, 0xf801, true);
    memory.setUint16(0x106, 0x4770, true);
    cpu.step();
    assert.equal(cpu.pc, 0x100);
    assert.ok(cpu.cpsr & 32);
    cpu.step();
    cpu.step();
    assert.equal(cpu.pc, 0x106);
    assert.equal(cpu.r[14], 0x105);
    cpu.step();
    assert.equal(cpu.pc, 0x104);
});

test('barrel shifts cover RRX, zero, 32 and larger amounts', () => {
    const { cpu } = fixture();
    cpu.cpsr |= 0x20000000;
    assert.deepEqual(cpu.shift(2, 3, 0, true), { value: 0x80000001, carry: 0 });
    assert.deepEqual(cpu.shift(1, 0, 32), { value: 0, carry: 1 });
    assert.deepEqual(cpu.shift(1, 0, 33), { value: 0, carry: 0 });
    assert.deepEqual(cpu.shift(0x80000000, 1, 0, true), { value: 0, carry: 1 });
    assert.deepEqual(cpu.shift(0x80000000, 2, 80), {
        value: 0xffffffff,
        carry: 1,
    });
});

test('IRQ banks SP/LR and SUBS PC restores Thumb CPSR', () => {
    const { cpu, memory } = fixture();
    cpu.setCPSR(0x6000003f);
    cpu.pc = 0x100;
    cpu.r[13] = 0x800;
    cpu.banks[0x12][5] = 0x900;
    cpu.exception(0x12, 0x18, 0x104);
    assert.equal(cpu.r[13], 0x900);
    memory.setUint32(0x18, 0xe25ef004, true);
    cpu.step();
    assert.equal(cpu.pc, 0x100);
    assert.equal(cpu.cpsr, 0x6000003f);
    assert.equal(cpu.r[13], 0x800);
});

test('unaligned loads rotate and v5 signed halfword multiply is decoded', () => {
    const { cpu, bus } = fixture([0xe1600281]);
    bus.write32(0x100, 0x44332211);
    assert.equal(cpu.loadWord(0x101), 0x11443322);
    cpu.r[1] = 0xffff;
    cpu.r[2] = 3;
    cpu.step();
    assert.equal(cpu.r[0], 0xfffffffd);
});

test('v5 saturating arithmetic keeps sticky Q without changing NZCV', () => {
    const { cpu } = fixture([0xe1010052, 0xe1610052]);
    cpu.cpsr = 0x6000001f;
    cpu.r[1] = 1;
    cpu.r[2] = 0x7fffffff;
    cpu.step();
    assert.equal(cpu.r[0], 0x7fffffff);
    assert.equal(cpu.cpsr, 0x6800001f);
    cpu.r[1] = 0x40000000;
    cpu.r[2] = 0;
    cpu.step();
    assert.equal(cpu.r[0], 0x80000001);
    assert.equal(cpu.cpsr, 0x6800001f);
    cpu.v5 = false;
    assert.throws(() => cpu.arm(0xe1010052), /Unsupported ARM/);
    assert.throws(() => cpu.arm(0xe16f0f10), /Unsupported ARM/);
});
