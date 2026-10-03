// Initialize the documented post-IPL environment without distributing a PIF ROM.
// The IPL transfers the first MiB of payload to the cartridge header's entry.
function bootN64(cpu, bus, header) {
    const entry = header.entryPoint >>> 0;
    const start = entry & 0x1fffffff;
    const length = Math.min(0x100000, bus.rom.length - 0x1000);
    if (start + length > bus.ram.length) {
        throw new Error('N64 cartridge boot payload is outside RDRAM.');
    }
    bus.ram.set(bus.rom.subarray(0x1000, 0x1000 + length), start);
    bus.spMem.set(bus.rom.subarray(0, 0x1000));
    bus.write32(0x300, header.region === 'PAL' ? 0 : 1);
    bus.write32(0x304, 0);
    bus.write32(0x308, 0xb0000000);
    bus.write32(0x30c, 0);
    bus.write32(0x310, 0);
    bus.write32(0x314, 0);
    bus.write32(0x318, bus.ram.length);
    cpu.set32(20, header.region === 'PAL' ? 0 : 1);
    cpu.set32(22, 0x3f);
    cpu.set32(29, 0xa4001ff0);
    cpu.set32(31, 0xa4001550);
    cpu.setPC(entry);
}

export { bootN64 };
