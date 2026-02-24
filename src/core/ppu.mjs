const STATUS_SPRITE_OVERFLOW = 0x20;
const STATUS_SPRITE0_HIT = 0x40;
const STATUS_VBLANK = 0x80;

const MASK_SHOW_BACKGROUND = 0x08;
const MASK_SHOW_SPRITES = 0x10;

const CTRL_NMI_ENABLE = 0x80;
const CTRL_BG_PATTERN = 0x10;
const CTRL_SPRITE_PATTERN = 0x08;
const CTRL_INCREMENT = 0x04;

const NES_RGB_PALETTE = [
    0x666666, 0x002a88, 0x1412a7, 0x3b00a4,
    0x5c007e, 0x6e0040, 0x6c0600, 0x561d00,
    0x333500, 0x0b4800, 0x005200, 0x004f08,
    0x00404d, 0x000000, 0x000000, 0x000000,
    0xadadad, 0x155fd9, 0x4240ff, 0x7527fe,
    0xa01acc, 0xb71e7b, 0xb53120, 0x994e00,
    0x6b6d00, 0x388700, 0x0e9300, 0x008f32,
    0x007c8d, 0x000000, 0x000000, 0x000000,
    0xfffeff, 0x64b0ff, 0x9290ff, 0xc676ff,
    0xf36aff, 0xfe6ecc, 0xfe8170, 0xea9e22,
    0xbcbe00, 0x88d800, 0x5ce430, 0x45e082,
    0x48cdde, 0x4f4f4f, 0x000000, 0x000000,
    0xfffeff, 0xc0dfff, 0xd3d2ff, 0xe8c8ff,
    0xfbc2ff, 0xfec4ea, 0xfeccc5, 0xf7d8a5,
    0xe4e594, 0xcfef96, 0xbdf4ab, 0xb3f3cc,
    0xb5ebf2, 0xb8b8b8, 0x000000, 0x000000,
];

function packColor(rgb) {
    return (0xff << 24) | rgb;
}

class PPU {
    constructor(bus, cartridge) {
        this.bus = bus;
        this.cartridge = cartridge;

        this.ctrl = 0;
        this.mask = 0;
        this.status = 0;
        this.oamAddr = 0;

        this.vramAddress = 0;
        this.tempAddress = 0;
        this.fineX = 0;
        this.writeToggle = false;
        this.dataBuffer = 0;
        this.openBus = 0;

        this.scrollX = 0;
        this.scrollY = 0;
        this.scanlineScrollX = new Uint16Array(240);
        this.scanlineScrollY = new Uint16Array(240);
        this.scanlineBaseNameTable = new Uint8Array(240);

        this.vram = new Uint8Array(0x1000);
        this.paletteRam = new Uint8Array(0x20);
        this.oam = new Uint8Array(0x100);
        this.frameBuffer = new Uint32Array(256 * 240);
        this.bgOpaque = new Uint8Array(256 * 240);

        this.cycle = 0;
        this.scanline = 261;
        this.frame = 0;
        this.frameReady = false;
    }

    clock(cycles) {
        for (let index = 0; index < cycles; index += 1) {
            this.#tick();
        }
    }

    #tick() {
        if (this.scanline >= 0 && this.scanline < 240 && this.cycle === 0) {
            this.#latchScanlineState(this.scanline);
        }

        if (
            this.scanline >= 0 &&
            this.scanline < 240 &&
            this.cycle >= 1 &&
            this.cycle <= 256
        ) {
            this.#updateSprite0Hit();
        }

        if (this.scanline === 241 && this.cycle === 1) {
            this.status |= STATUS_VBLANK;

            if (this.ctrl & CTRL_NMI_ENABLE) {
                this.bus.requestNMI();
            }
        }

        if (this.scanline === 261 && this.cycle === 1) {
            this.status &= ~(STATUS_VBLANK | STATUS_SPRITE0_HIT);
            this.status &= ~STATUS_SPRITE_OVERFLOW;
            this.frameReady = false;
        }

        this.cycle += 1;

        if (this.cycle <= 340) {
            return;
        }

        this.cycle = 0;
        this.scanline += 1;

        if (this.scanline <= 261) {
            return;
        }

        this.scanline = 0;
        this.frame += 1;
        this.#renderFrame();
        this.frameReady = true;
    }

    #updateSprite0Hit() {
        if ((this.mask & (MASK_SHOW_BACKGROUND | MASK_SHOW_SPRITES)) !==
            (MASK_SHOW_BACKGROUND | MASK_SHOW_SPRITES)) {
            return;
        }

        if (this.status & STATUS_SPRITE0_HIT) {
            return;
        }

        const spriteY = this.oam[0];
        const spriteX = this.oam[3];

        if (this.scanline === spriteY + 1 && this.cycle === spriteX + 1) {
            this.status |= STATUS_SPRITE0_HIT;
        }
    }

    #renderFrame() {
        const showBackground = (this.mask & MASK_SHOW_BACKGROUND) !== 0;
        const showSprites = (this.mask & MASK_SHOW_SPRITES) !== 0;
        const universal = this.#readPalette(0);
        const baseColor = packColor(NES_RGB_PALETTE[universal]);

        if (!showBackground) {
            this.frameBuffer.fill(baseColor);
            this.bgOpaque.fill(0);
        } else {
            this.#renderBackground();
        }

        if (showSprites) {
            this.#renderSprites();
        }
    }

    #renderBackground() {
        const patternBase = (this.ctrl & CTRL_BG_PATTERN) ? 0x1000 : 0x0000;

        for (let y = 0; y < 240; y += 1) {
            const lineScrollX = this.scanlineScrollX[y] & 0x1ff;
            const lineScrollY = this.scanlineScrollY[y] & 0xff;
            const baseNameTable = this.scanlineBaseNameTable[y] & 0x03;
            const baseNtX = baseNameTable & 1;
            const baseNtY = (baseNameTable >> 1) & 1;

            for (let x = 0; x < 256; x += 1) {
                const worldX = (x + lineScrollX) & 0x1ff;
                const worldY = (y + lineScrollY) % 480;
                const localY = worldY % 240;
                const ntX = (baseNtX + (worldX >> 8)) & 1;
                const ntY = (baseNtY + Math.floor(worldY / 240)) & 1;
                const coarseX = (worldX >> 3) & 0x1f;
                const coarseY = (localY >> 3) % 30;
                const fineX = worldX & 0x07;
                const fineY = localY & 0x07;
                const nameTable = (ntY << 1) | ntX;
                const base = 0x2000 + (nameTable * 0x0400);
                const tileAddress = base + (coarseY * 32) + coarseX;
                const tileId = this.#readVRAM(tileAddress);
                const attrAddress = base + 0x03c0 +
                    ((coarseY >> 2) * 8) + (coarseX >> 2);
                const attribute = this.#readVRAM(attrAddress);
                const shift = ((coarseY & 0x02) << 1) | (coarseX & 0x02);
                const paletteGroup = (attribute >> shift) & 0x03;
                const tileRow = patternBase + (tileId * 16) + fineY;
                const low = this.cartridge.ppuRead(tileRow);
                const high = this.cartridge.ppuRead(tileRow + 8);
                const bit = 7 - fineX;
                const pixelLow = ((low >> bit) & 0x01) |
                    (((high >> bit) & 0x01) << 1);
                const paletteIndex = pixelLow === 0
                    ? 0
                    : (paletteGroup << 2) | pixelLow;
                const colorId = this.#readPalette(paletteIndex);
                const color = packColor(NES_RGB_PALETTE[colorId]);
                const offset = (y * 256) + x;

                this.frameBuffer[offset] = color;
                this.bgOpaque[offset] = pixelLow === 0 ? 0 : 1;
            }
        }
    }

    #latchScanlineState(scanline) {
        this.scanlineScrollX[scanline] = this.scrollX & 0xff;
        this.scanlineScrollY[scanline] = this.scrollY & 0xff;
        this.scanlineBaseNameTable[scanline] = this.ctrl & 0x03;
    }

    #renderSprites() {
        const spritePatternBase =
            (this.ctrl & CTRL_SPRITE_PATTERN) ? 0x1000 : 0x0000;

        for (let index = 0; index < 64; index += 1) {
            const base = index * 4;
            const y = this.oam[base] + 1;
            const tile = this.oam[base + 1];
            const attr = this.oam[base + 2];
            const x = this.oam[base + 3];
            const flipH = (attr & 0x40) !== 0;
            const flipV = (attr & 0x80) !== 0;
            const behindBg = (attr & 0x20) !== 0;
            const palette = attr & 0x03;

            for (let row = 0; row < 8; row += 1) {
                const py = y + row;

                if (py < 0 || py >= 240) {
                    continue;
                }

                const tileRow = flipV ? (7 - row) : row;
                const patternAddress =
                    spritePatternBase + (tile * 16) + tileRow;
                const low = this.cartridge.ppuRead(patternAddress);
                const high = this.cartridge.ppuRead(patternAddress + 8);

                for (let column = 0; column < 8; column += 1) {
                    const px = x + column;

                    if (px < 0 || px >= 256) {
                        continue;
                    }

                    const bit = flipH ? column : (7 - column);
                    const pixelLow = ((low >> bit) & 0x01) |
                        (((high >> bit) & 0x01) << 1);

                    if (pixelLow === 0) {
                        continue;
                    }

                    const offset = (py * 256) + px;

                    if (behindBg && this.bgOpaque[offset]) {
                        continue;
                    }

                    const paletteIndex = 0x10 + (palette << 2) + pixelLow;
                    const colorId = this.#readPalette(paletteIndex);
                    this.frameBuffer[offset] =
                        packColor(NES_RGB_PALETTE[colorId]);
                }
            }
        }
    }

    readRegister(address) {
        const register = 0x2000 + (address & 0x0007);

        if (register === 0x2002) {
            const value = (this.status & 0xe0) | (this.openBus & 0x1f);
            this.status &= ~STATUS_VBLANK;
            this.writeToggle = false;
            this.openBus = value;
            return value;
        }

        if (register === 0x2004) {
            const value = this.oam[this.oamAddr];
            this.openBus = value;
            return value;
        }

        if (register === 0x2007) {
            const addressV = this.vramAddress & 0x3fff;
            let value;

            if (addressV >= 0x3f00) {
                value = this.#readVRAM(addressV);
                this.dataBuffer = this.#readVRAM(addressV - 0x1000);
            } else {
                value = this.dataBuffer;
                this.dataBuffer = this.#readVRAM(addressV);
            }

            this.vramAddress =
                (this.vramAddress + this.#vramIncrement()) & 0x7fff;
            this.openBus = value;
            return value;
        }

        return this.openBus;
    }

    writeRegister(address, value) {
        const register = 0x2000 + (address & 0x0007);
        const byte = value & 0xff;
        this.openBus = byte;

        if (register === 0x2000) {
            const nmiBefore = (this.ctrl & CTRL_NMI_ENABLE) !== 0;
            this.ctrl = byte;
            this.tempAddress =
                (this.tempAddress & 0xf3ff) | ((byte & 0x03) << 10);

            if (
                !nmiBefore &&
                (this.ctrl & CTRL_NMI_ENABLE) !== 0 &&
                (this.status & STATUS_VBLANK) !== 0
            ) {
                this.bus.requestNMI();
            }
            return;
        }

        if (register === 0x2001) {
            this.mask = byte;
            return;
        }

        if (register === 0x2003) {
            this.oamAddr = byte;
            return;
        }

        if (register === 0x2004) {
            this.oam[this.oamAddr] = byte;
            this.oamAddr = (this.oamAddr + 1) & 0xff;
            return;
        }

        if (register === 0x2005) {
            if (!this.writeToggle) {
                this.scrollX = byte;
                this.fineX = byte & 0x07;
                this.tempAddress = (this.tempAddress & 0x7fe0) | (byte >> 3);
                this.writeToggle = true;
            } else {
                this.scrollY = byte;
                this.tempAddress =
                    (this.tempAddress & 0x0c1f) |
                    ((byte & 0x07) << 12) |
                    ((byte & 0xf8) << 2);
                this.writeToggle = false;
            }
            return;
        }

        if (register === 0x2006) {
            if (!this.writeToggle) {
                this.tempAddress =
                    (this.tempAddress & 0x00ff) |
                    ((byte & 0x3f) << 8);
                this.writeToggle = true;
            } else {
                this.tempAddress = (this.tempAddress & 0xff00) | byte;
                this.vramAddress = this.tempAddress;
                this.writeToggle = false;
            }
            return;
        }

        if (register === 0x2007) {
            this.#writeVRAM(this.vramAddress & 0x3fff, byte);
            this.vramAddress =
                (this.vramAddress + this.#vramIncrement()) & 0x7fff;
        }
    }

    writeOamDma(byte) {
        this.oam[this.oamAddr] = byte & 0xff;
        this.oamAddr = (this.oamAddr + 1) & 0xff;
    }

    #vramIncrement() {
        return (this.ctrl & CTRL_INCREMENT) ? 32 : 1;
    }

    #nameTableIndex(address) {
        const offset = (address - 0x2000) & 0x0fff;
        const table = offset >> 10;
        const inner = offset & 0x03ff;

        if (this.cartridge.header.mirroring === 'four-screen') {
            return (table * 0x0400) + inner;
        }

        if (this.cartridge.header.mirroring === 'vertical') {
            return ((table & 1) * 0x0400) + inner;
        }

        return (((table >> 1) & 1) * 0x0400) + inner;
    }

    #paletteIndex(address) {
        let index = (address - 0x3f00) & 0x1f;

        if (index === 0x10) {
            index = 0x00;
        } else if (index === 0x14) {
            index = 0x04;
        } else if (index === 0x18) {
            index = 0x08;
        } else if (index === 0x1c) {
            index = 0x0c;
        }

        return index;
    }

    #readVRAM(address) {
        const mapped = address & 0x3fff;

        if (mapped < 0x2000) {
            return this.cartridge.ppuRead(mapped);
        }

        if (mapped < 0x3f00) {
            const index = this.#nameTableIndex(mapped);
            return this.vram[index];
        }

        return this.paletteRam[this.#paletteIndex(mapped)];
    }

    #writeVRAM(address, value) {
        const mapped = address & 0x3fff;
        const byte = value & 0xff;

        if (mapped < 0x2000) {
            this.cartridge.ppuWrite(mapped, byte);
            return;
        }

        if (mapped < 0x3f00) {
            const index = this.#nameTableIndex(mapped);
            this.vram[index] = byte;
            return;
        }

        this.paletteRam[this.#paletteIndex(mapped)] = byte;
    }

    #readPalette(index) {
        return this.paletteRam[this.#paletteIndex(0x3f00 + index)] & 0x3f;
    }

    saveState() {
        return {
            ctrl: this.ctrl,
            mask: this.mask,
            status: this.status,
            oamAddr: this.oamAddr,
            vramAddress: this.vramAddress,
            tempAddress: this.tempAddress,
            fineX: this.fineX,
            writeToggle: this.writeToggle,
            dataBuffer: this.dataBuffer,
            openBus: this.openBus,
            scrollX: this.scrollX,
            scrollY: this.scrollY,
            scanlineScrollX: Array.from(this.scanlineScrollX),
            scanlineScrollY: Array.from(this.scanlineScrollY),
            scanlineBaseNameTable: Array.from(this.scanlineBaseNameTable),
            vram: Array.from(this.vram),
            paletteRam: Array.from(this.paletteRam),
            oam: Array.from(this.oam),
            frameBuffer: Array.from(this.frameBuffer),
            cycle: this.cycle,
            scanline: this.scanline,
            frame: this.frame,
            frameReady: this.frameReady,
        };
    }

    loadState(state) {
        this.ctrl = state.ctrl;
        this.mask = state.mask;
        this.status = state.status;
        this.oamAddr = state.oamAddr;
        this.vramAddress = state.vramAddress;
        this.tempAddress = state.tempAddress;
        this.fineX = state.fineX;
        this.writeToggle = state.writeToggle;
        this.dataBuffer = state.dataBuffer;
        this.openBus = state.openBus;
        this.scrollX = state.scrollX;
        this.scrollY = state.scrollY;
        if (state.scanlineScrollX) {
            this.scanlineScrollX.set(state.scanlineScrollX);
        }
        if (state.scanlineScrollY) {
            this.scanlineScrollY.set(state.scanlineScrollY);
        }
        if (state.scanlineBaseNameTable) {
            this.scanlineBaseNameTable.set(state.scanlineBaseNameTable);
        }
        this.vram.set(state.vram);
        this.paletteRam.set(state.paletteRam);
        this.oam.set(state.oam);
        this.frameBuffer.set(state.frameBuffer);
        this.cycle = state.cycle;
        this.scanline = state.scanline;
        this.frame = state.frame;
        this.frameReady = state.frameReady;
    }
}

export {
    PPU,
};
