// Documented BIOS services implemented without distributing Nintendo BIOS.
function biosService(number, cpu, bus, ds = false) {
    const r = cpu.r;
    const read32 = (a) => bus.read32(a >>> 0);
    const write32 = (a, v) => bus.write32(a >>> 0, v);
    if (ds && number === 3) {
        const cycles = Math.max(1, Math.min(0x1000000, r[0] * 4));
        r[0] = 0;
        return cycles;
    }
    if (ds && number === 0x0e) {
        let crc = r[0] & 65535;
        if (r[2] > 0x1000000) throw new Error('Invalid BIOS CRC length.');
        for (let i = 0; i < r[2]; i += 1) {
            crc ^= bus.read8(r[1] + i);
            for (let bit = 0; bit < 8; bit += 1)
                crc = (crc >>> 1) ^ (crc & 1 ? 0xa001 : 0);
        }
        r[0] = crc;
        return;
    }
    if (ds && number === 0x0f) {
        r[0] = 0;
        return;
    }
    if (ds && number === 0x1a) {
        r[0] = Math.round(Math.sin((r[0] * Math.PI) / 128) * 32768) & 65535;
        return;
    }
    if (ds && number === 0x1b) {
        r[0] = Math.floor((2 ** (r[0] / 768) - 1) * 65536);
        return;
    }
    if (ds && number === 0x1c) {
        r[0] = Math.min(127, Math.floor(127 * 10 ** ((r[0] - 723) / 200)));
        return;
    }
    if (number === 0) {
        cpu.setCPSR(0x1f);
        cpu.branch(ds ? bus.entry : 0x08000000);
        return;
    }
    if (number === 1 && !ds) {
        const regions = [
            [0x02000000, 0x40000],
            [0x03000000, 0x7e00],
            [0x05000000, 0x400],
            [0x06000000, 0x18000],
            [0x07000000, 0x400],
        ];
        for (let i = 0; i < regions.length; i += 1)
            if (r[0] & (1 << i)) {
                const [address, size] = regions[i];
                for (let offset = 0; offset < size; offset += 4)
                    write32(address + offset, 0);
            }
        return;
    }
    if (
        (!ds && (number === 2 || number === 3)) ||
        (ds && (number === 6 || number === 7))
    ) {
        cpu.halted = true;
        return;
    }
    if (number === 4 || number === 5) {
        bus.waitMask = number === 5 ? 1 : r[1];
        if (number === 5 || r[0]) bus.waitFlags &= ~bus.waitMask;
        if (bus.waitFlags & bus.waitMask) {
            bus.waitMask = 0;
            return;
        }
        bus.setReg?.(0x208, 1);
        cpu.halted = true;
        return;
    }
    if ((!ds && (number === 6 || number === 7)) || (ds && number === 9)) {
        const a = r[number === 7 ? 1 : 0] | 0,
            b = r[number === 7 ? 0 : 1] | 0;
        const quotient = b === 0 ? (a < 0 ? 1 : -1) : Math.trunc(a / b);
        r[0] = quotient;
        r[1] = b === 0 ? a : a % b;
        r[3] = Math.abs(quotient);
        return;
    }
    if ((!ds && number === 8) || (ds && number === 0x0d)) {
        r[0] = Math.floor(Math.sqrt(r[0]));
        return;
    }
    if (!ds && (number === 9 || number === 10)) {
        r[0] =
            number === 9
                ? Math.trunc(
                      (Math.atan(((r[0] << 16) >> 16) / 16384) * 32768) /
                          Math.PI,
                  )
                : Math.round(
                      (Math.atan2((r[1] << 16) >> 16, (r[0] << 16) >> 16) *
                          32768) /
                          Math.PI,
                  ) & 65535;
        return;
    }
    if (number === 0x0b || number === 0x0c) {
        const word = number === 0x0c || r[2] & 0x04000000;
        let count = r[2] & 0x1fffff;
        if (number === 0x0c) count = (count + 7) & ~7;
        if (count > 0x400000) throw new Error('Invalid BIOS copy length.');
        const size = word ? 4 : 2;
        const source = r[0] & ~(size - 1),
            dest = r[1] & ~(size - 1);
        for (let i = 0; i < count; i += 1) {
            const address = source + (r[2] & 0x01000000 ? 0 : i * size);
            if (word) write32(dest + i * size, read32(address));
            else bus.write16(dest + i * size, bus.read16(address));
        }
        return;
    }
    if (!ds && (number === 0x0e || number === 0x0f)) {
        let source = r[0],
            dest = r[1];
        const count = r[2],
            object = number === 0x0f;
        if (count > 0x10000) throw new Error('Invalid affine transform count.');
        const signed = (address) => (bus.read16(address) << 16) >> 16;
        for (let i = 0; i < count; i += 1) {
            const scale = object ? source : source + 12;
            const sx = signed(scale),
                sy = signed(scale + 2);
            const angle = ((bus.read16(scale + 4) >>> 8) * Math.PI * 2) / 256;
            const a = Math.trunc(Math.cos(angle) * sx),
                b = Math.trunc(-Math.sin(angle) * sx);
            const c = Math.trunc(Math.sin(angle) * sy),
                d = Math.trunc(Math.cos(angle) * sy);
            const stride = object ? r[3] : 2;
            [a, b, c, d].forEach((v, j) => bus.write16(dest + j * stride, v));
            if (!object) {
                const ox = signed(source + 8),
                    oy = signed(source + 10);
                write32(dest + 8, read32(source) - a * ox - b * oy);
                write32(dest + 12, read32(source + 4) - c * ox - d * oy);
            }
            source += object ? 8 : 20;
            dest += object ? stride * 4 : 16;
        }
        return;
    }
    if (number === 0x10) {
        const length = bus.read16(r[2]),
            srcBits = bus.read8(r[2] + 2),
            dstBits = bus.read8(r[2] + 3);
        const offset = read32(r[2] + 4);
        if (
            ![1, 2, 4, 8].includes(srcBits) ||
            ![1, 2, 4, 8, 16, 32].includes(dstBits)
        ) {
            throw new Error('Invalid BIOS BitUnPack field size.');
        }
        let packed = 0,
            bits = 0,
            dest = r[1];
        for (let i = 0; i < length; i += 1) {
            const byte = bus.read8(r[0] + i);
            for (let shift = 0; shift < 8; shift += srcBits) {
                let value = (byte >>> shift) & ((1 << srcBits) - 1);
                if (value || offset & 0x80000000) value += offset & 0x7fffffff;
                packed |= value << bits;
                bits += dstBits;
                if (bits === 32) {
                    write32(dest, packed);
                    dest += 4;
                    packed = bits = 0;
                }
            }
        }
        if (bits) write32(dest, packed);
        return;
    }
    if ([0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18].includes(number)) {
        let source = r[0],
            dest = r[1];
        const header = read32(source),
            length = header >>> 8,
            kind = header & 0xf0;
        if (length > 0x1000000)
            throw new Error('Invalid BIOS decompression length.');
        const out = new Uint8Array(length);
        source += 4;
        let index = 0;
        if (kind === 0x10) {
            while (index < length) {
                const flags = bus.read8(source++);
                for (let bit = 7; bit >= 0 && index < length; bit -= 1) {
                    if (!(flags & (1 << bit)))
                        out[index++] = bus.read8(source++);
                    else {
                        const a = bus.read8(source++),
                            b = bus.read8(source++);
                        const count = (a >>> 4) + 3,
                            distance = ((a & 15) << 8) + b + 1;
                        if (distance > index)
                            throw new Error('Invalid LZ77 backreference.');
                        for (let j = 0; j < count && index < length; j += 1) {
                            out[index] = out[index - distance];
                            index += 1;
                        }
                    }
                }
            }
        } else if (kind === 0x30) {
            while (index < length) {
                const flags = bus.read8(source++),
                    count = (flags & 127) + (flags & 128 ? 3 : 1);
                if (flags & 128) {
                    const value = bus.read8(source++);
                    for (let j = 0; j < count && index < length; j += 1)
                        out[index++] = value;
                } else
                    for (let j = 0; j < count && index < length; j += 1)
                        out[index++] = bus.read8(source++);
            }
        } else if (kind === 0x80) {
            const size = (header & 15) === 2 ? 2 : 1;
            let accumulator = 0;
            while (index < length) {
                accumulator +=
                    size === 2 ? bus.read16(source) : bus.read8(source);
                source += size;
                out[index++] = accumulator & 255;
                if (size === 2) out[index++] = accumulator >>> 8;
            }
        } else if (kind === 0x20) {
            const bits = header & 15;
            const treeSize = (bus.read8(source) + 1) * 2;
            const tree = source + 1;
            let input = (source + treeSize + 1) & ~3,
                word = 0,
                remaining = 0,
                node = 0,
                nibble = 0;
            while (index < length) {
                if (!remaining) {
                    word = read32(input);
                    input += 4;
                    remaining = 32;
                }
                const branch = word >>> 31;
                word <<= 1;
                remaining -= 1;
                const descriptor = bus.read8(tree + node);
                const next = (node & ~1) + ((descriptor & 63) + 1) * 2 + branch;
                if (descriptor & (branch ? 64 : 128)) {
                    const value = bus.read8(tree + next);
                    if (bits === 8) out[index++] = value;
                    else if (bits === 4) {
                        if (!nibble) {
                            out[index] = value & 15;
                            nibble = 1;
                        } else {
                            out[index++] |= value << 4;
                            nibble = 0;
                        }
                    } else throw new Error('Unsupported Huffman symbol size.');
                    node = 0;
                } else node = next;
            }
        } else
            throw new Error(
                `Unsupported BIOS compression 0x${kind.toString(16)}`,
            );
        // VRAM ignores CPU byte writes; BIOS VRAM services use halfwords.
        if (
            number === 0x12 ||
            number === 0x15 ||
            number === 0x17 ||
            dest >>> 24 === 6
        ) {
            for (let i = 0; i < length; i += 2)
                bus.write16(dest + i, out[i] | ((out[i + 1] ?? 0) << 8));
        } else for (let i = 0; i < length; i += 1) bus.write8(dest + i, out[i]);
        return;
    }
    if (!ds && number === 0x0d) {
        r[0] = 0xbaae187f;
        return;
    }
    if ((!ds && number === 0x19) || (ds && number === 8)) return;
    throw new Error(
        `Unsupported ${ds ? 'DS' : 'GBA'} BIOS service 0x${number.toString(16)}`,
    );
}

export { biosService };
