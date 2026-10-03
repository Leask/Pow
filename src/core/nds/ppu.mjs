import { color15 } from '../../shared/nintendo/color.mjs';

const SIZES = [
    [
        [8, 8],
        [16, 16],
        [32, 32],
        [64, 64],
    ],
    [
        [16, 8],
        [32, 8],
        [32, 16],
        [64, 32],
    ],
    [
        [8, 16],
        [8, 32],
        [16, 32],
        [32, 64],
    ],
];
class NDSPPU {
    constructor(machine) {
        this.machine = machine;
        this.frameBuffer = new Uint32Array(256 * 384).fill(0xff000000);
        this.affineX = new Int32Array(4);
        this.affineY = new Int32Array(4);
    }
    reg(engine, offset) {
        const io = this.machine.buses[0].io;
        offset += engine * 0x1000;
        return io[offset] | (io[offset + 1] << 8);
    }
    signed(engine, offset) {
        return (this.reg(engine, offset) << 16) >> 16;
    }
    read(engine, offset, object = false) {
        return this.machine.readVRAM(
            0x06000000 + engine * 0x200000 + (object ? 0x400000 : 0) + offset,
        );
    }
    read16(engine, offset, object = false) {
        return (
            this.read(engine, offset, object) |
            (this.read(engine, offset + 1, object) << 8)
        );
    }
    palette(engine, object, index) {
        const data = this.machine.palette,
            offset = engine * 1024 + (object ? 512 : 0) + index * 2;
        return data[offset] | (data[offset + 1] << 8);
    }
    latch(engine, index) {
        const offset = 0x28 + index * 16;
        const value = (a) =>
            ((this.reg(engine, a) | (this.reg(engine, a + 2) << 16)) << 4) >> 4;
        this.affineX[engine * 2 + index] = value(offset);
        this.affineY[engine * 2 + index] = value(offset + 4);
    }
    text(engine, bg, x, y) {
        const control = this.reg(engine, 8 + bg * 2),
            size = control >>> 14;
        const width = size & 1 ? 512 : 256,
            height = size & 2 ? 512 : 256;
        x = (x + this.reg(engine, 0x10 + bg * 4)) & (width - 1);
        y = (y + this.reg(engine, 0x12 + bg * 4)) & (height - 1);
        const displayHigh = this.reg(engine, 2);
        const mapBase = engine ? 0 : ((displayHigh >>> 11) & 7) * 0x10000;
        const charBase = engine ? 0 : ((displayHigh >>> 8) & 7) * 0x10000;
        const block = (x >>> 8) + (y >>> 8) * (width >>> 8);
        const map =
            mapBase +
            ((control >>> 8) & 31) * 2048 +
            block * 2048 +
            ((y & 255) >>> 3) * 64 +
            ((x & 255) >>> 3) * 2;
        const tile = this.read16(engine, map);
        const row = tile & 0x800 ? 7 - (y & 7) : y & 7;
        const column = tile & 0x400 ? 7 - (x & 7) : x & 7;
        const color256 = control & 128;
        const address =
            charBase +
            ((control >>> 2) & 15) * 16384 +
            (tile & 1023) * (color256 ? 64 : 32) +
            row * (color256 ? 8 : 4) +
            (color256 ? column : column >>> 1);
        const byte = this.read(engine, address);
        const index = color256 ? byte : (byte >>> ((column & 1) * 4)) & 15;
        return index
            ? this.palette(
                  engine,
                  false,
                  index + (color256 ? 0 : (tile >>> 12) * 16),
              )
            : -1;
    }
    affine(engine, bg, x, mode) {
        const index = engine * 2 + bg - 2,
            offset = 0x20 + (bg - 2) * 16;
        const control = this.reg(engine, 8 + bg * 2);
        let px = (this.affineX[index] + this.signed(engine, offset) * x) >> 8;
        let py =
            (this.affineY[index] + this.signed(engine, offset + 4) * x) >> 8;
        const extended =
            (mode === 3 && bg === 3) || (mode === 4 && bg === 3) || mode === 5;
        const bitmap = extended && control & 128;
        const dims = bitmap
            ? [
                  [128, 128],
                  [256, 256],
                  [512, 256],
                  [512, 512],
              ][control >>> 14]
            : [128 << (control >>> 14), 128 << (control >>> 14)];
        const [width, height] = dims;
        if (control & 0x2000) {
            px &= width - 1;
            py &= height - 1;
        } else if (px < 0 || px >= width || py < 0 || py >= height) return -1;
        if (bitmap) {
            const base = ((control >>> 8) & 31) * 16384;
            if (control & 4) {
                const color = this.read16(engine, base + (py * width + px) * 2);
                return color & 0x8000 ? color & 0x7fff : -1;
            }
            const index = this.read(engine, base + py * width + px);
            return index ? this.palette(engine, false, index) : -1;
        }
        const base = ((control >>> 8) & 31) * 2048;
        const map =
            base +
            ((py >>> 3) * (width >>> 3) + (px >>> 3)) * (extended ? 2 : 1);
        const tile = extended
            ? this.read16(engine, map)
            : this.read(engine, map);
        const row = tile & 0x800 ? 7 - (py & 7) : py & 7;
        const column = tile & 0x400 ? 7 - (px & 7) : px & 7;
        const value = this.read(
            engine,
            ((control >>> 2) & 15) * 16384 +
                (tile & 1023) * 64 +
                row * 8 +
                column,
        );
        return value ? this.palette(engine, false, value) : -1;
    }
    sprites(engine, y, display) {
        const colors = new Int32Array(256).fill(-1),
            priorities = new Uint8Array(256).fill(4);
        if (!(display & 0x1000)) return { colors, priorities };
        const data = this.machine.oam;
        const read = (offset) =>
            data[engine * 1024 + offset] |
            (data[engine * 1024 + offset + 1] << 8);
        for (let i = 0; i < 128; i += 1) {
            const a = read(i * 8),
                b = read(i * 8 + 2),
                c = read(i * 8 + 4);
            if (
                (!(a & 256) && a & 512) ||
                a >>> 14 === 3 ||
                ((a >>> 10) & 3) === 2
            )
                continue;
            const [width, height] = SIZES[a >>> 14][b >>> 14];
            const double = (a & 0x300) === 0x300,
                boxW = width * (double ? 2 : 1),
                boxH = height * (double ? 2 : 1);
            const x0 = (b & 511) >= 256 ? (b & 511) - 512 : b & 511;
            const y0 = (a & 255) >= 192 ? (a & 255) - 256 : a & 255;
            if (y < y0 || y >= y0 + boxH) continue;
            const color256 = !!(a & 0x2000),
                priority = (c >>> 10) & 3;
            for (
                let x = Math.max(0, x0);
                x < Math.min(256, x0 + boxW);
                x += 1
            ) {
                if (priorities[x] <= priority) continue;
                let px = x - x0,
                    py = y - y0;
                if (a & 256) {
                    const matrix = ((b >>> 9) & 31) * 32;
                    const signed = (offset) =>
                        (read(matrix + offset) << 16) >> 16;
                    const dx = px - boxW / 2,
                        dy = py - boxH / 2;
                    px = ((signed(6) * dx + signed(14) * dy) >> 8) + width / 2;
                    py =
                        ((signed(22) * dx + signed(30) * dy) >> 8) + height / 2;
                    if (px < 0 || px >= width || py < 0 || py >= height)
                        continue;
                } else {
                    if (b & 0x1000) px = width - 1 - px;
                    if (b & 0x2000) py = height - 1 - py;
                }
                const high = this.reg(engine, 2);
                const tileBase =
                    (c & (color256 ? 1022 : 1023)) *
                    (display & 16 ? 32 << ((high >>> 4) & 3) : 32);
                const stride =
                    display & 16 ? (width / 8) * (color256 ? 2 : 1) : 32;
                const address =
                    tileBase +
                    ((py >>> 3) * stride + (px >>> 3) * (color256 ? 2 : 1)) *
                        32 +
                    (py & 7) * (color256 ? 8 : 4) +
                    (color256 ? px & 7 : (px & 7) >>> 1);
                const byte = this.read(engine, address, true);
                const value = color256 ? byte : (byte >>> ((px & 1) * 4)) & 15;
                if (!value) continue;
                colors[x] = this.palette(
                    engine,
                    true,
                    value + (color256 ? 0 : (c >>> 12) * 16),
                );
                priorities[x] = priority;
            }
        }
        return { colors, priorities };
    }
    renderLine(y) {
        const power = this.machine.buses[0].reg(0x304);
        for (let engine = 0; engine < 2; engine += 1) {
            const display = this.reg(engine, 0),
                high = this.reg(engine, 2);
            const screen = (power & 0x8000 ? engine : 1 - engine) * 192;
            const output = (screen + y) * 256;
            const displayMode = (high >>> 0) & 3;
            if (display & 128 || displayMode === 0) {
                this.frameBuffer.fill(0xffffffff, output, output + 256);
                continue;
            }
            if (
                engine === 0 &&
                displayMode === 1 &&
                (display & 0x108) === 0x108
            ) {
                throw new Error('NDS 3D BG0 rendering is not implemented.');
            }
            if (engine === 0 && displayMode === 2) {
                const base = 0x06800000 + ((high >>> 2) & 3) * 0x20000;
                for (let x = 0; x < 256; x += 1) {
                    const address = base + (y * 256 + x) * 2;
                    this.frameBuffer[output + x] = color15(
                        this.machine.readVRAM(address) |
                            (this.machine.readVRAM(address + 1) << 8),
                    );
                }
                continue;
            }
            const sprites = this.sprites(engine, y, display),
                mode = display & 7;
            const brightness = this.reg(engine, 0x6c),
                factor = Math.min(16, brightness & 31);
            for (let x = 0; x < 256; x += 1) {
                let color = this.palette(engine, false, 0),
                    key = 99;
                for (let bg = 0; bg < 4; bg += 1) {
                    if (!(display & (256 << bg))) continue;
                    const priority =
                        (this.reg(engine, 8 + bg * 2) & 3) * 8 + bg + 1;
                    if (priority >= key) continue;
                    const affine =
                        (mode === 1 && bg === 3) ||
                        (mode === 2 && bg >= 2) ||
                        (mode === 3 && bg === 3) ||
                        (mode === 4 && bg >= 2) ||
                        (mode === 5 && bg >= 2);
                    const value = affine
                        ? this.affine(engine, bg, x, mode)
                        : this.text(engine, bg, x, y);
                    if (value >= 0) {
                        color = value;
                        key = priority;
                    }
                }
                if (sprites.priorities[x] * 8 < key && sprites.colors[x] >= 0)
                    color = sprites.colors[x];
                if (brightness >>> 14 === 1 || brightness >>> 14 === 2) {
                    let result = 0;
                    for (let shift = 0; shift <= 10; shift += 5) {
                        const v = (color >>> shift) & 31;
                        result |=
                            (brightness >>> 14 === 1
                                ? v + (((31 - v) * factor) >>> 4)
                                : v - ((v * factor) >>> 4)) << shift;
                    }
                    color = result;
                }
                this.frameBuffer[output + x] = color15(color);
            }
            for (let index = 0; index < 2; index += 1) {
                this.affineX[engine * 2 + index] += this.signed(
                    engine,
                    0x22 + index * 16,
                );
                this.affineY[engine * 2 + index] += this.signed(
                    engine,
                    0x26 + index * 16,
                );
            }
        }
    }
}

export { NDSPPU };
