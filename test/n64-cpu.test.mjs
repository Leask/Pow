import test from 'node:test';
import assert from 'node:assert/strict';
import { VR4300 } from '../src/core/n64/cpu-vr4300.mjs';
import { N64Bus } from '../src/core/n64/bus.mjs';

function machine(words) {
    const bus = new N64Bus(new Uint8Array(4096));
    words.forEach((word, index) => bus.write32(index * 4, word));
    const cpu = new VR4300(bus);
    cpu.setPC(0x80000000);
    return { cpu, bus };
}

test('VR4300 executes the delay slot and annuls untaken likely branches', () => {
    const { cpu } = machine([
        0x24010001, // ADDIU r1, r0, 1
        0x10210002, // BEQ r1, r1, +2
        0x24210001, // ADDIU r1, r1, 1 (delay)
        0x24210008, // skipped
        0x50010001, // BEQL r0, r1, +1 (untaken)
        0x24210010, // annulled
        0x24210002,
    ]);
    for (let i = 0; i < 5; i += 1) cpu.step();
    assert.equal(cpu.lo[1], 4);
    assert.equal(cpu.pc, 0x8000001c);
});

test('VR4300 reports a delay-slot address exception against the branch', () => {
    const { cpu } = machine([0x10000001, 0x8c010001]);
    cpu.step();
    cpu.step();
    assert.equal(cpu.cp0[8], 1);
    assert.equal(cpu.cp0[14], 0x80000000);
    assert.equal(cpu.cp0[13] >>> 31, 1);
    assert.equal(cpu.cp0[13] & 0x7c, 4 << 2);
    assert.equal(cpu.pc, 0x80000180);
});

test('VR4300 maintains 64-bit registers and big-endian doubleword memory', () => {
    const { cpu, bus } = machine([0xdc220000, 0x0002183c, 0xfc230008]);
    cpu.set32(1, 0x80000100);
    bus.write32(0x100, 0x12345678);
    bus.write32(0x104, 0x9abcdef0);
    cpu.step();
    assert.equal(cpu.get64(2, true), 0x123456789abcdef0n);
    cpu.step();
    cpu.step();
    assert.equal(bus.read32(0x108), 0x9abcdef0);
    assert.equal(bus.read32(0x10c), 0);
});

test('VR4300 LWL/LWR and SWL/SWR merge every unaligned byte position', () => {
    for (let offset = 0; offset < 4; offset += 1) {
        const { cpu, bus } = machine([
            0x88220000, 0x98220003, 0xa8220010, 0xb8220013,
        ]);
        cpu.set32(1, 0x80000100 + offset);
        for (let i = 0; i < 8; i += 1) bus.write8(0x100 + i, 0x80 + i);
        cpu.step();
        cpu.step();
        assert.equal(cpu.lo[2], bus.ramView.getUint32(0x100 + offset));
        assert.equal(cpu.hi[2], -1);
        cpu.step();
        cpu.step();
        assert.equal(bus.ramView.getUint32(0x110 + offset), cpu.lo[2]);
    }
});

test('VR4300 signed overflow traps without overwriting the destination', () => {
    const { cpu } = machine([0x20220001]);
    cpu.set32(1, 0x7fffffff);
    cpu.set32(2, 19);
    cpu.step();
    assert.equal(cpu.lo[2], 19);
    assert.equal(cpu.cp0[13] & 0x7c, 12 << 2);
});

test('VR4300 Count/Compare raises and acknowledges the timer interrupt', () => {
    const { cpu } = machine([0, 0, 0, 0x40815800]);
    cpu.cp0[11] = 2;
    cpu.step();
    cpu.step();
    assert.equal(cpu.cp0[13] & 0x8000, 0x8000);
    cpu.step();
    cpu.step();
    assert.equal(cpu.cp0[13] & 0x8000, 0);
});

test('VR4300 COP1 single precision rounds and double precision pairs words', () => {
    const { cpu, bus } = machine([
        0xc4220000, 0xc4240004, 0x46041180, 0xe4260008, 0xd4280010, 0xf4280018,
    ]);
    cpu.cp0[12] &= ~0x04000000;
    cpu.set32(1, 0x80000100);
    bus.ramView.setFloat32(0x100, 1.25);
    bus.ramView.setFloat32(0x104, 2.5);
    bus.ramView.setFloat64(0x110, Math.PI);
    for (let i = 0; i < 6; i += 1) cpu.step();
    assert.equal(bus.ramView.getFloat32(0x108), 3.75);
    assert.equal(bus.ramView.getFloat64(0x118), Math.PI);
});

test('VR4300 TLB resolves ASID pages and generates modification exceptions', () => {
    const { cpu, bus } = machine([0x8c220000, 0xac220000]);
    cpu.set32(1, 0x00400000);
    cpu.cp0[10] = 7;
    cpu.tlb[0] = { mask: 0, hi: 0x00400007, lo0: (0x2000 >>> 6) | 2, lo1: 0 };
    bus.write32(0x2000, 0x12345678);
    cpu.step();
    assert.equal(cpu.lo[2], 0x12345678);
    cpu.step();
    assert.equal(cpu.cp0[13] & 0x7c, 1 << 2);
    assert.equal(cpu.cp0[8], 0x00400000);
});
