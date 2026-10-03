import { color15 } from '../../shared/nintendo/color.mjs';

const DMG_COLORS = new Uint32Array([
    0xffe0f8d0, 0xff88c070, 0xff346856, 0xff081820,
]);

class GBPPU {
    constructor(bus) {
        this.bus = bus;
        this.frameBuffer = new Uint32Array(160 * 144);
        this.frameBuffer.fill(DMG_COLORS[0]);
        this.dot = 0;
        this.line = 0;
        this.frame = 0;
        this.windowLine = 0;
        this.statSignal = false;
        this.colors = new Uint8Array(160);
        this.priority = new Uint8Array(160);
    }

    mode() {
        if (!(this.bus.io[0x40] & 128)) return 0;
        if (this.line >= 144) return 1;
        return this.dot < 80 ? 2 : this.dot < 252 ? 3 : 0;
    }

    stat() {
        const io = this.bus.io,
            mode = this.mode();
        const match = this.line === io[0x45];
        const signal =
            !!(io[0x40] & 128) &&
            ((io[0x41] & (8 << mode) && mode !== 3) ||
                (match && io[0x41] & 64));
        if (signal && !this.statSignal) this.bus.interrupt(1);
        this.statSignal = !!signal;
        return 128 | (io[0x41] & 0x78) | (match ? 4 : 0) | mode;
    }

    clock(cycles) {
        if (!(this.bus.io[0x40] & 128)) {
            this.line = 0;
            this.dot = 0;
            this.windowLine = 0;
            this.statSignal = false;
            return;
        }
        while (cycles > 0) {
            const boundary =
                this.line >= 144
                    ? 456
                    : this.dot < 80
                      ? 80
                      : this.dot < 252
                        ? 252
                        : 456;
            const delta = Math.min(cycles, boundary - this.dot);
            this.dot += delta;
            cycles -= delta;
            if (this.dot === 252 && this.line < 144) {
                this.renderLine();
                this.bus.hblankDMA();
            }
            if (this.dot === 456) {
                this.dot = 0;
                this.line += 1;
                if (this.line === 144) {
                    this.bus.interrupt(0);
                    this.frame += 1;
                }
                if (this.line === 154) {
                    this.line = 0;
                    this.windowLine = 0;
                }
            }
            this.stat();
        }
    }

    palette(object, palette, index) {
        if (!this.bus.color) {
            const reg = this.bus.io[object ? 0x48 + palette : 0x47];
            return DMG_COLORS[(reg >>> (index * 2)) & 3];
        }
        const data = object ? this.bus.objPalette : this.bus.bgPalette;
        const offset = palette * 8 + index * 2;
        return color15(data[offset] | (data[offset + 1] << 8));
    }

    renderLine() {
        const bus = this.bus,
            io = bus.io,
            lcd = io[0x40];
        const output = this.line * 160;
        const bgEnabled = bus.color || lcd & 1;
        let usedWindow = false;
        for (let x = 0; x < 160; x += 1) {
            const window =
                bgEnabled &&
                lcd & 32 &&
                this.line >= io[0x4a] &&
                io[0x4b] <= 166 &&
                x >= io[0x4b] - 7;
            usedWindow ||= !!window;
            const px = window ? x - io[0x4b] + 7 : (x + io[0x43]) & 255;
            const py = window ? this.windowLine : (this.line + io[0x42]) & 255;
            const map =
                (lcd & (window ? 64 : 8) ? 0x1c00 : 0x1800) +
                (py >>> 3) * 32 +
                (px >>> 3);
            const tile = bus.vram[map];
            const attr = bus.color ? bus.vram[0x2000 + map] : 0;
            const base =
                lcd & 16 ? tile * 16 : 0x1000 + ((tile << 24) >> 24) * 16;
            const row = attr & 64 ? 7 - (py & 7) : py & 7;
            const bit = attr & 32 ? px & 7 : 7 - (px & 7);
            const address = base + row * 2 + (attr & 8 ? 0x2000 : 0);
            const index = bgEnabled
                ? ((bus.vram[address] >>> bit) & 1) |
                  (((bus.vram[address + 1] >>> bit) & 1) << 1)
                : 0;
            this.colors[x] = index;
            this.priority[x] = attr & 128;
            this.frameBuffer[output + x] = this.palette(false, attr & 7, index);
        }
        if (usedWindow) this.windowLine += 1;
        if (!(lcd & 2)) return;
        const height = lcd & 4 ? 16 : 8;
        const sprites = [];
        for (let index = 0; index < 40 && sprites.length < 10; index += 1) {
            const y = bus.oam[index * 4] - 16;
            if (this.line >= y && this.line < y + height) sprites.push(index);
        }
        if (!bus.color || io[0x6c] & 1) {
            sprites.sort(
                (a, b) => bus.oam[a * 4 + 1] - bus.oam[b * 4 + 1] || a - b,
            );
        }
        const occupied = new Uint8Array(160);
        for (const index of sprites) {
            const offset = index * 4,
                x0 = bus.oam[offset + 1] - 8;
            const attr = bus.oam[offset + 3];
            let row = this.line - (bus.oam[offset] - 16);
            if (attr & 64) row = height - 1 - row;
            const tile = bus.oam[offset + 2] & (height === 16 ? 254 : 255);
            const address =
                tile * 16 + row * 2 + (bus.color && attr & 8 ? 8192 : 0);
            for (let sx = 0; sx < 8; sx += 1) {
                const x = x0 + sx;
                if (x < 0 || x >= 160 || occupied[x]) continue;
                const bit = attr & 32 ? sx : 7 - sx;
                const value =
                    ((bus.vram[address] >>> bit) & 1) |
                    (((bus.vram[address + 1] >>> bit) & 1) << 1);
                if (!value) continue;
                occupied[x] = 1;
                if (
                    this.colors[x] &&
                    (!bus.color || lcd & 1) &&
                    (attr & 128 || this.priority[x])
                )
                    continue;
                this.frameBuffer[output + x] = this.palette(
                    true,
                    bus.color ? attr & 7 : (attr >>> 4) & 1,
                    value,
                );
            }
        }
    }
}

export { GBPPU };
