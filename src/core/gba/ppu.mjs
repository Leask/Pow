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

class GBAPPU {
    constructor(bus) {
        this.bus = bus;
        this.frameBuffer = new Uint32Array(240 * 160).fill(0xff000000);
        this.affineX = new Int32Array(2);
        this.affineY = new Int32Array(2);
        this.objColor = new Int32Array(240);
        this.objPriority = new Uint8Array(240);
        this.objAlpha = new Uint8Array(240);
        this.objWindow = new Uint8Array(240);
    }
    reg(offset) {
        return this.bus.io[offset] | (this.bus.io[offset + 1] << 8);
    }
    signed(offset) {
        return (this.reg(offset) << 16) >> 16;
    }
    vram16(offset) {
        offset %= this.bus.vram.length;
        return (
            this.bus.vram[offset] |
            (this.bus.vram[(offset + 1) % this.bus.vram.length] << 8)
        );
    }
    palette(index) {
        return (
            this.bus.palette[(index * 2) & 1023] |
            (this.bus.palette[(index * 2 + 1) & 1023] << 8)
        );
    }
    latchAffine(index) {
        const offset = 0x28 + index * 16;
        const value = (a) =>
            ((this.reg(a) | (this.reg(a + 2) << 16)) << 4) >> 4;
        this.affineX[index] = value(offset);
        this.affineY[index] = value(offset + 4);
    }
    textPixel(bg, x, y) {
        const control = this.reg(8 + bg * 2),
            size = control >>> 14;
        const width = size & 1 ? 512 : 256,
            height = size & 2 ? 512 : 256;
        x = (x + this.reg(0x10 + bg * 4)) & (width - 1);
        y = (y + this.reg(0x12 + bg * 4)) & (height - 1);
        const block = (x >>> 8) + (y >>> 8) * (width >>> 8);
        const map =
            ((control >>> 8) & 31) * 2048 +
            block * 2048 +
            ((y & 255) >>> 3) * 64 +
            ((x & 255) >>> 3) * 2;
        const tile = this.vram16(map);
        let row = y & 7,
            column = x & 7;
        if (tile & 0x800) row = 7 - row;
        if (tile & 0x400) column = 7 - column;
        const color256 = control & 128;
        const address =
            ((control >>> 2) & 3) * 16384 +
            (tile & 1023) * (color256 ? 64 : 32) +
            row * (color256 ? 8 : 4) +
            (color256 ? column : column >>> 1);
        const byte = this.bus.vram[address % this.bus.vram.length];
        const index = color256 ? byte : (byte >>> ((column & 1) * 4)) & 15;
        return index === 0
            ? -1
            : this.palette(index + (color256 ? 0 : (tile >>> 12) * 16));
    }
    affinePixel(bg, x, y, mode) {
        const index = bg - 2,
            offset = 0x20 + index * 16;
        const control = this.reg(8 + bg * 2);
        let px = (this.affineX[index] + this.signed(offset) * x) >> 8;
        let py = (this.affineY[index] + this.signed(offset + 4) * x) >> 8;
        if (mode >= 3) {
            const width = mode === 5 ? 160 : 240,
                height = mode === 5 ? 128 : 160;
            if (px < 0 || px >= width || py < 0 || py >= height) return -1;
            const page = mode !== 3 && this.reg(0) & 16 ? 0xa000 : 0;
            if (mode === 4) {
                const value = this.bus.vram[page + py * width + px];
                return value ? this.palette(value) : -1;
            }
            return this.vram16(page + (py * width + px) * 2);
        }
        const size = 128 << (control >>> 14);
        if (control & 0x2000) {
            px &= size - 1;
            py &= size - 1;
        } else if (px < 0 || py < 0 || px >= size || py >= size) return -1;
        const map =
            ((control >>> 8) & 31) * 2048 +
            (py >>> 3) * (size >>> 3) +
            (px >>> 3);
        const tile = this.bus.vram[map % this.bus.vram.length];
        const address =
            ((control >>> 2) & 3) * 16384 + tile * 64 + (py & 7) * 8 + (px & 7);
        const value = this.bus.vram[address % this.bus.vram.length];
        return value ? this.palette(value) : -1;
    }
    sprites(y, display) {
        this.objColor.fill(-1);
        this.objPriority.fill(4);
        this.objAlpha.fill(0);
        this.objWindow.fill(0);
        if (!(display & 0x1000)) return;
        const oam = this.bus.oam;
        const read = (a) => oam[a] | (oam[a + 1] << 8);
        for (let i = 0; i < 128; i += 1) {
            const a = read(i * 8),
                b = read(i * 8 + 2),
                c = read(i * 8 + 4);
            if (!(a & 0x100) && a & 0x200) continue;
            const shape = a >>> 14;
            if (shape === 3) continue;
            const [width, height] = SIZES[shape][b >>> 14];
            const affine = !!(a & 256),
                double = affine && a & 512;
            const boxW = double ? width * 2 : width,
                boxH = double ? height * 2 : height;
            const y0 = (a & 255) >= 160 ? (a & 255) - 256 : a & 255;
            const x0 = (b & 511) >= 240 ? (b & 511) - 512 : b & 511;
            if (y < y0 || y >= y0 + boxH) continue;
            const color256 = !!(a & 0x2000),
                priority = (c >>> 10) & 3;
            const objMode = (a >>> 10) & 3;
            if (objMode === 3) continue;
            for (
                let screenX = Math.max(0, x0);
                screenX < Math.min(240, x0 + boxW);
                screenX += 1
            ) {
                let px = screenX - x0,
                    py = y - y0;
                if (affine) {
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
                const stride =
                    display & 64 ? (width / 8) * (color256 ? 2 : 1) : 32;
                const tile =
                    (c & (color256 ? 1022 : 1023)) +
                    (py >>> 3) * stride +
                    (px >>> 3) * (color256 ? 2 : 1);
                const address =
                    0x10000 +
                    tile * 32 +
                    (py & 7) * (color256 ? 8 : 4) +
                    (color256 ? px & 7 : (px & 7) >>> 1);
                if ((display & 7) >= 3 && address < 0x14000) continue;
                const byte = this.bus.vram[address % this.bus.vram.length];
                const value = color256 ? byte : (byte >>> ((px & 1) * 4)) & 15;
                if (!value) continue;
                if (objMode === 2) {
                    this.objWindow[screenX] = 1;
                    continue;
                }
                if (priority >= this.objPriority[screenX]) continue;
                this.objColor[screenX] = this.palette(
                    256 + value + (color256 ? 0 : (c >>> 12) * 16),
                );
                this.objPriority[screenX] = priority;
                this.objAlpha[screenX] = objMode === 1 ? 1 : 0;
            }
        }
    }
    windowMask(x, y, display) {
        if (!(display & 0xe000)) return 63;
        const within = (v, min, max) =>
            min <= max ? v >= min && v < max : v >= min || v < max;
        for (let i = 0; i < 2; i += 1)
            if (display & (0x2000 << i)) {
                const horizontal = this.reg(0x40 + i * 2),
                    vertical = this.reg(0x44 + i * 2);
                if (
                    within(x, horizontal >>> 8, horizontal & 255) &&
                    within(y, vertical >>> 8, vertical & 255)
                ) {
                    return this.bus.io[0x48 + i] & 63;
                }
            }
        return (
            this.bus.io[display & 0x8000 && this.objWindow[x] ? 0x4b : 0x4a] &
            63
        );
    }
    blend(a, b, eva, evb) {
        let value = 0;
        for (let shift = 0; shift <= 10; shift += 5) {
            value |=
                Math.min(
                    31,
                    (((a >>> shift) & 31) * eva +
                        ((b >>> shift) & 31) * evb) >>>
                        4,
                ) << shift;
        }
        return value;
    }
    renderLine(y) {
        const display = this.reg(0),
            mode = display & 7;
        if (display & 128) {
            this.frameBuffer.fill(0xffffffff, y * 240, (y + 1) * 240);
            return;
        }
        this.sprites(y, display);
        const blend = this.reg(0x50),
            alpha = this.reg(0x52),
            fade = Math.min(16, this.reg(0x54) & 31);
        for (let x = 0; x < 240; x += 1) {
            const mask = this.windowMask(x, y, display);
            let top = this.palette(0),
                second = top,
                topLayer = 5,
                secondLayer = 5;
            let topKey = 99,
                secondKey = 100,
                semi = false;
            const add = (color, layer, key, objectAlpha = false) => {
                if (color < 0) return;
                if (key < topKey) {
                    second = top;
                    secondLayer = topLayer;
                    secondKey = topKey;
                    top = color;
                    topLayer = layer;
                    topKey = key;
                    semi = objectAlpha;
                } else if (key < secondKey) {
                    second = color;
                    secondLayer = layer;
                    secondKey = key;
                }
            };
            for (let bg = 0; bg < 4; bg += 1) {
                if (!(display & (256 << bg)) || !(mask & (1 << bg))) continue;
                let color = -1;
                if (mode === 0 || (mode === 1 && bg < 2))
                    color = this.textPixel(bg, x, y);
                else if (
                    (mode === 1 && bg === 2) ||
                    (mode === 2 && bg >= 2) ||
                    (mode >= 3 && mode <= 5 && bg === 2)
                ) {
                    color = this.affinePixel(bg, x, y, mode);
                }
                add(color, bg, (this.reg(8 + bg * 2) & 3) * 8 + bg + 1);
            }
            if (mask & 16)
                add(
                    this.objColor[x],
                    4,
                    this.objPriority[x] * 8,
                    !!this.objAlpha[x],
                );
            const effect = (blend >>> 6) & 3;
            if (
                (mask & 32 || semi) &&
                blend & (256 << secondLayer) &&
                (semi || (effect === 1 && blend & (1 << topLayer)))
            ) {
                top = this.blend(
                    top,
                    second,
                    Math.min(16, alpha & 31),
                    Math.min(16, (alpha >>> 8) & 31),
                );
            } else if (mask & 32 && blend & (1 << topLayer) && effect >= 2) {
                top = this.blend(
                    top,
                    effect === 2 ? 0x7fff : 0,
                    16 - fade,
                    fade,
                );
            }
            this.frameBuffer[y * 240 + x] = color15(top);
        }
        for (let i = 0; i < 2; i += 1) {
            this.affineX[i] += this.signed(0x22 + i * 16);
            this.affineY[i] += this.signed(0x26 + i * 16);
        }
    }
}

export { GBAPPU };
