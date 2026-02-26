const SNES_WIDTH = 256;
const SNES_HEIGHT = 224;
const MASTER_CYCLES_PER_SCANLINE = 1364;
const HBLANK_START_CYCLE = 1096;
const SCANLINES_PER_FRAME = 262;
const VBLANK_START_SCANLINE = 225;
const FRAME_MASTER_CYCLES = MASTER_CYCLES_PER_SCANLINE * SCANLINES_PER_FRAME;
const LAYER_BACKDROP = 0;
const LAYER_BG1 = 1;
const LAYER_BG2 = 2;
const LAYER_BG3 = 3;
const LAYER_BG4 = 4;
const LAYER_OBJ = 5;

function clampToByte(value) {
    return value & 0xff;
}

function bgr555ToRgba(color, brightness = 15) {
    const red = color & 0x1f;
    const green = (color >>> 5) & 0x1f;
    const blue = (color >>> 10) & 0x1f;
    const scale = Math.max(0, Math.min(brightness, 15)) / 15;
    const r8 = (((red << 3) | (red >>> 2)) * scale) & 0xff;
    const g8 = (((green << 3) | (green >>> 2)) * scale) & 0xff;
    const b8 = (((blue << 3) | (blue >>> 2)) * scale) & 0xff;

    return (
        (0xff << 24) |
        ((r8 & 0xff) << 16) |
        ((g8 & 0xff) << 8) |
        (b8 & 0xff)
    ) >>> 0;
}

class SNESPPU {
    constructor() {
        this.registers = new Uint8Array(0x40);
        this.vram = new Uint8Array(64 * 1024);
        this.cgram = new Uint8Array(512);
        this.oam = new Uint8Array(544);

        this.frameBuffer = new Uint32Array(SNES_WIDTH * SNES_HEIGHT);
        this.frame = 0;
        this.scanline = 0;
        this.cycle = 0;

        this.masterCycleInFrame = 0;
        this.vblank = false;
        this.nmiEnabled = false;
        this.nmiPending = false;
        this.nmiFlag = false;

        this.vramAddress = 0;
        this.vramIncrement = 1;
        this.vramIncrementOnLow = false;
        this.vramAddressRemapMode = 0;
        this.cgramAddress = 0;
        this.cgramHighLatch = false;
        this.oamAddress = 0;
        this.oamByteAddress = 0;

        this.bg1Hofs = 0;
        this.bg1Vofs = 0;
        this.bg2Hofs = 0;
        this.bg2Vofs = 0;
        this.bg3Hofs = 0;
        this.bg3Vofs = 0;
        this.bg4Hofs = 0;
        this.bg4Vofs = 0;
        this.bgofsLatch = 0;
        this.bghofsLatch = 0;
        this.fixedColorR = 0;
        this.fixedColorG = 0;
        this.fixedColorB = 0;
        this.scanlineState = new Array(SNES_HEIGHT);

        this._clearFrameBuffer();
        this._clearScanlineState();
    }

    clock(masterCycles) {
        let remaining = masterCycles >>> 0;

        while (remaining > 0) {
            const beforeCycle = this.masterCycleInFrame;
            const beforeScanline = Math.floor(
                beforeCycle / MASTER_CYCLES_PER_SCANLINE,
            );
            const step = remaining;
            const afterCycle = (beforeCycle + step) % FRAME_MASTER_CYCLES;
            const crossedFrame = beforeCycle + step >= FRAME_MASTER_CYCLES;

            this.masterCycleInFrame = afterCycle;
            this.scanline = Math.floor(
                this.masterCycleInFrame / MASTER_CYCLES_PER_SCANLINE,
            );
            this.cycle = this.masterCycleInFrame % MASTER_CYCLES_PER_SCANLINE;

            if (beforeScanline < VBLANK_START_SCANLINE &&
                this.scanline >= VBLANK_START_SCANLINE) {
                this._renderFrame();
                this._enterVBlank();
            }

            if (crossedFrame) {
                this._exitVBlank();
                this.frame += 1;
            }

            remaining = 0;
        }
    }

    pollNMI() {
        if (!this.nmiPending) {
            return false;
        }

        this.nmiPending = false;
        return true;
    }

    setNMIEnabled(enabled) {
        this.nmiEnabled = Boolean(enabled);
    }

    readNMIStatus() {
        const value = this.nmiFlag ? 0x80 : 0x00;
        this.nmiFlag = false;
        return value;
    }

    readHVBJOYStatus() {
        const inVBlank = this.vblank ? 0x80 : 0x00;
        const inHBlank = this.cycle >= HBLANK_START_CYCLE ? 0x40 : 0x00;

        return inVBlank | inHBlank;
    }

    readPPURegister(index) {
        const mapped = index & 0x3f;

        if (mapped === 0x39 || mapped === 0x3a) {
            const byteSelect = mapped === 0x39 ? 0 : 1;
            const byteOffset = this._resolveVRAMByteOffset(byteSelect);
            const value = this.vram[byteOffset];

            if (byteSelect === 0) {
                if (this.vramIncrementOnLow) {
                    this._incrementVRAMAddress();
                }
            } else if (!this.vramIncrementOnLow) {
                this._incrementVRAMAddress();
            }

            return value;
        }

        if (mapped === 0x3b) {
            const byteOffset = (this.cgramAddress << 1) + (this.cgramHighLatch ? 1 : 0);
            const value = this.cgram[byteOffset & 0x1ff];
            this.cgramHighLatch = !this.cgramHighLatch;

            if (!this.cgramHighLatch) {
                this.cgramAddress = (this.cgramAddress + 1) & 0xff;
            }

            return value;
        }

        return this.registers[mapped];
    }

    writePPURegister(index, value) {
        const mapped = index & 0x3f;
        const byte = value & 0xff;

        this.registers[mapped] = byte;

        switch (mapped) {
        case 0x02:
            this.oamAddress = (this.oamAddress & 0x0100) | byte;
            this.oamByteAddress = ((this.oamAddress << 1) % this.oam.length);
            break;
        case 0x03:
            this.oamAddress = ((byte & 0x01) << 8) | (this.oamAddress & 0x00ff);
            this.oamByteAddress = ((this.oamAddress << 1) % this.oam.length);
            break;
        case 0x04:
            if (this._canAccessOAMPort()) {
                this.oam[this.oamByteAddress] = byte;
                this.oamByteAddress = (this.oamByteAddress + 1) % this.oam.length;
                this.oamAddress = (this.oamByteAddress >>> 1) & 0x01ff;
            }
            break;
        case 0x15:
            this._updateVMain(byte);
            break;
        case 0x16:
            this.vramAddress = (this.vramAddress & 0xff00) | byte;
            break;
        case 0x17:
            this.vramAddress = (this.vramAddress & 0x00ff) | (byte << 8);
            break;
        case 0x18:
            if (this._canAccessVRAMPort()) {
                this._writeVRAMByte(0, byte);
            }
            if (this.vramIncrementOnLow) {
                this._incrementVRAMAddress();
            }
            break;
        case 0x19:
            if (this._canAccessVRAMPort()) {
                this._writeVRAMByte(1, byte);
            }
            if (!this.vramIncrementOnLow) {
                this._incrementVRAMAddress();
            }
            break;
        case 0x21:
            this.cgramAddress = byte;
            this.cgramHighLatch = false;
            break;
        case 0x22:
            this._writeCGRAM(byte);
            break;
        case 0x32:
            this._writeFixedColor(byte);
            break;
        case 0x0d:
            this._writeBGScroll(1, true, byte);
            break;
        case 0x0e:
            this._writeBGScroll(1, false, byte);
            break;
        case 0x0f:
            this._writeBGScroll(2, true, byte);
            break;
        case 0x10:
            this._writeBGScroll(2, false, byte);
            break;
        case 0x11:
            this._writeBGScroll(3, true, byte);
            break;
        case 0x12:
            this._writeBGScroll(3, false, byte);
            break;
        case 0x13:
            this._writeBGScroll(4, true, byte);
            break;
        case 0x14:
            this._writeBGScroll(4, false, byte);
            break;
        default:
            break;
        }
    }

    saveState() {
        return {
            registers: Array.from(this.registers),
            vram: Array.from(this.vram),
            cgram: Array.from(this.cgram),
            oam: Array.from(this.oam),
            frame: this.frame,
            scanline: this.scanline,
            cycle: this.cycle,
            masterCycleInFrame: this.masterCycleInFrame,
            vblank: this.vblank,
            nmiEnabled: this.nmiEnabled,
            nmiPending: this.nmiPending,
            nmiFlag: this.nmiFlag,
            vramAddress: this.vramAddress,
            vramIncrement: this.vramIncrement,
            vramIncrementOnLow: this.vramIncrementOnLow,
            vramAddressRemapMode: this.vramAddressRemapMode,
            cgramAddress: this.cgramAddress,
            cgramHighLatch: this.cgramHighLatch,
            oamAddress: this.oamAddress,
            oamByteAddress: this.oamByteAddress,
            bg1Hofs: this.bg1Hofs,
            bg1Vofs: this.bg1Vofs,
            bg2Hofs: this.bg2Hofs,
            bg2Vofs: this.bg2Vofs,
            bg3Hofs: this.bg3Hofs,
            bg3Vofs: this.bg3Vofs,
            bg4Hofs: this.bg4Hofs,
            bg4Vofs: this.bg4Vofs,
            bgofsLatch: this.bgofsLatch,
            bghofsLatch: this.bghofsLatch,
            fixedColorR: this.fixedColorR,
            fixedColorG: this.fixedColorG,
            fixedColorB: this.fixedColorB,
            scanlineState: this.scanlineState,
        };
    }

    loadState(state) {
        this.registers.set(state.registers);
        this.vram.set(state.vram);
        this.cgram.set(state.cgram);
        this.oam.set(state.oam ?? []);
        this.frame = state.frame >>> 0;
        this.scanline = state.scanline >>> 0;
        this.cycle = state.cycle >>> 0;
        this.masterCycleInFrame = state.masterCycleInFrame >>> 0;
        this.vblank = Boolean(state.vblank);
        this.nmiEnabled = Boolean(state.nmiEnabled);
        this.nmiPending = Boolean(state.nmiPending);
        this.nmiFlag = Boolean(state.nmiFlag);
        this.vramAddress = state.vramAddress & 0xffff;
        this.vramIncrement = state.vramIncrement >>> 0;
        this.vramIncrementOnLow = Boolean(state.vramIncrementOnLow);
        this.vramAddressRemapMode = (state.vramAddressRemapMode ?? 0) & 0x03;
        this.cgramAddress = state.cgramAddress & 0xff;
        this.cgramHighLatch = Boolean(state.cgramHighLatch);
        this.oamAddress = (state.oamAddress ?? 0) & 0x01ff;
        this.oamByteAddress = (state.oamByteAddress ?? 0) % this.oam.length;
        this.bg1Hofs = state.bg1Hofs & 0x03ff;
        this.bg1Vofs = state.bg1Vofs & 0x03ff;
        this.bg2Hofs = (state.bg2Hofs ?? 0) & 0x03ff;
        this.bg2Vofs = (state.bg2Vofs ?? 0) & 0x03ff;
        this.bg3Hofs = (state.bg3Hofs ?? 0) & 0x03ff;
        this.bg3Vofs = (state.bg3Vofs ?? 0) & 0x03ff;
        this.bg4Hofs = (state.bg4Hofs ?? 0) & 0x03ff;
        this.bg4Vofs = (state.bg4Vofs ?? 0) & 0x03ff;
        this.bgofsLatch = (state.bgofsLatch ?? 0) & 0xff;
        this.bghofsLatch = (state.bghofsLatch ?? 0) & 0xff;
        this.fixedColorR = (state.fixedColorR ?? 0) & 0x1f;
        this.fixedColorG = (state.fixedColorG ?? 0) & 0x1f;
        this.fixedColorB = (state.fixedColorB ?? 0) & 0x1f;
        this.scanlineState = state.scanlineState ??
            new Array(SNES_HEIGHT);
        this._renderFrame();
    }

    latchScanlineState(scanline) {
        if (!Number.isInteger(scanline) ||
            scanline < 0 ||
            scanline >= SNES_HEIGHT) {
            return;
        }

        this.scanlineState[scanline] = {
            windowSel23: this.registers[0x23],
            windowSel24: this.registers[0x24],
            windowSel25: this.registers[0x25],
            windowLeft1: this.registers[0x26],
            windowRight1: this.registers[0x27],
            windowLeft2: this.registers[0x28],
            windowRight2: this.registers[0x29],
            windowLogicA: this.registers[0x2a],
            windowLogicB: this.registers[0x2b],
            windowMaskMain: this.registers[0x2e],
            windowMaskSub: this.registers[0x2f],
            tmMain: this.registers[0x2c],
            tmSub: this.registers[0x2d],
            bgMode: this.registers[0x05],
            cgwsel: this.registers[0x30],
            cgadsub: this.registers[0x31],
            fixedColorR: this.fixedColorR,
            fixedColorG: this.fixedColorG,
            fixedColorB: this.fixedColorB,
            bg1Hofs: this.bg1Hofs,
            bg1Vofs: this.bg1Vofs,
            bg2Hofs: this.bg2Hofs,
            bg2Vofs: this.bg2Vofs,
            bg3Hofs: this.bg3Hofs,
            bg3Vofs: this.bg3Vofs,
        };
    }

    _updateVMain(value) {
        const incrementTable = [1, 32, 128, 128];
        this.vramIncrement = incrementTable[value & 0x03];
        this.vramIncrementOnLow = (value & 0x80) === 0;
        this.vramAddressRemapMode = (value >>> 2) & 0x03;
    }

    _writeVRAMByte(byteSelect, value) {
        const byteOffset = this._resolveVRAMByteOffset(byteSelect);
        this.vram[byteOffset] = value & 0xff;
    }

    _incrementVRAMAddress() {
        this.vramAddress = (this.vramAddress + this.vramIncrement) & 0x7fff;
    }

    _resolveVRAMByteOffset(byteSelect) {
        const wordAddress = this._remapVRAMAddress(this.vramAddress & 0x7fff);
        return ((wordAddress << 1) + byteSelect) & 0xffff;
    }

    _remapVRAMAddress(address) {
        const wordAddress = address & 0x7fff;
        const mode = this.vramAddressRemapMode;

        if (mode === 0) {
            return wordAddress;
        }

        if (mode === 1) {
            return (
                (wordAddress & 0x7f00) |
                ((wordAddress & 0x001f) << 3) |
                ((wordAddress >>> 5) & 0x0007)
            ) & 0x7fff;
        }

        if (mode === 2) {
            return (
                (wordAddress & 0x7e00) |
                ((wordAddress & 0x003f) << 3) |
                ((wordAddress >>> 6) & 0x0007)
            ) & 0x7fff;
        }

        return (
            (wordAddress & 0x7c00) |
            ((wordAddress & 0x007f) << 3) |
            ((wordAddress >>> 7) & 0x0007)
        ) & 0x7fff;
    }

    _writeCGRAM(value) {
        const byteOffset = ((this.cgramAddress & 0xff) << 1) +
            (this.cgramHighLatch ? 1 : 0);
        this.cgram[byteOffset & 0x1ff] = value & 0xff;
        this.cgramHighLatch = !this.cgramHighLatch;

        if (!this.cgramHighLatch) {
            this.cgramAddress = (this.cgramAddress + 1) & 0xff;
        }
    }

    _canAccessVRAMPort() {
        return this.vblank || (this.registers[0x00] & 0x80) !== 0;
    }

    _canAccessOAMPort() {
        return this.vblank || (this.registers[0x00] & 0x80) !== 0;
    }

    _writeFixedColor(value) {
        const channelMask = value & 0xe0;
        const color = value & 0x1f;

        if ((channelMask & 0x80) !== 0) {
            this.fixedColorB = color;
        }

        if ((channelMask & 0x40) !== 0) {
            this.fixedColorG = color;
        }

        if ((channelMask & 0x20) !== 0) {
            this.fixedColorR = color;
        }
    }

    _writeBGScroll(layer, horizontal, value) {
        const byte = value & 0xff;

        if (horizontal) {
            const scrollValue = (
                (byte << 8) |
                (this.bgofsLatch & 0xf8) |
                (this.bghofsLatch & 0x07)
            ) & 0x03ff;
            this._setBGScroll(layer, true, scrollValue);
            this.bgofsLatch = byte;
            this.bghofsLatch = byte;
            return;
        }

        const scrollValue = ((byte << 8) | this.bgofsLatch) & 0x03ff;
        this._setBGScroll(layer, false, scrollValue);
        this.bgofsLatch = byte;
    }

    _setBGScroll(layer, horizontal, value) {
        const scroll = value & 0x03ff;

        if (layer === 1) {
            if (horizontal) {
                this.bg1Hofs = scroll;
            } else {
                this.bg1Vofs = scroll;
            }
            return;
        }

        if (layer === 2) {
            if (horizontal) {
                this.bg2Hofs = scroll;
            } else {
                this.bg2Vofs = scroll;
            }
            return;
        }

        if (layer === 3) {
            if (horizontal) {
                this.bg3Hofs = scroll;
            } else {
                this.bg3Vofs = scroll;
            }
            return;
        }

        if (layer === 4) {
            if (horizontal) {
                this.bg4Hofs = scroll;
            } else {
                this.bg4Vofs = scroll;
            }
        }
    }

    _enterVBlank() {
        this.vblank = true;
        this.nmiFlag = true;

        if (this.nmiEnabled) {
            this.nmiPending = true;
        }
    }

    _exitVBlank() {
        this.vblank = false;
    }

    _clearFrameBuffer() {
        this.frameBuffer.fill(0xff000000);
    }

    _clearScanlineState() {
        for (let index = 0; index < this.scanlineState.length; index += 1) {
            this.scanlineState[index] = null;
        }
    }

    _renderFrame() {
        const forcedBlank = (this.registers[0x00] & 0x80) !== 0;

        if (forcedBlank) {
            this._clearFrameBuffer();
            return;
        }

        const brightness = this.registers[0x00] & 0x0f;
        const bgMode = this.registers[0x05] & 0x07;
        const backdropColor = this._readPaletteColorBgr(0);
        const mainScreen = this._createScreenTarget(backdropColor, false);
        const subScreen = this._createScreenTarget(backdropColor, true);

        if (bgMode === 0 || bgMode === 1) {
            this._renderBG3(mainScreen);
            this._renderBG2(mainScreen);
            this._renderBG1(mainScreen);
            this._renderBG3(subScreen);
            this._renderBG2(subScreen);
            this._renderBG1(subScreen);
        }

        this._renderOBJ(mainScreen);
        this._renderOBJ(subScreen);
        this._composeMainAndSub(mainScreen, subScreen, brightness);

        this._clearScanlineState();
    }

    _createScreenTarget(backdropColor, subscreen) {
        const length = this.frameBuffer.length;
        const colors = new Uint16Array(length);
        const priorities = new Int16Array(length);
        const sources = new Uint8Array(length);
        const objMathEligible = new Uint8Array(length);

        colors.fill(backdropColor);
        priorities.fill(-32768);
        sources.fill(LAYER_BACKDROP);
        objMathEligible.fill(1);

        return {
            subscreen,
            colors,
            priorities,
            sources,
            objMathEligible,
        };
    }

    _composeMainAndSub(mainScreen, subScreen, brightness) {
        for (let y = 0; y < SNES_HEIGHT; y += 1) {
            const lineState = this.scanlineState[y];
            const cgwsel = lineState?.cgwsel ?? this.registers[0x30];
            const cgadsub = lineState?.cgadsub ?? this.registers[0x31];
            const addSubscreen = (cgwsel & 0x02) !== 0;
            const clipMode = (cgwsel >>> 6) & 0x03;
            const preventMode = (cgwsel >>> 4) & 0x03;
            const subtract = (cgadsub & 0x80) !== 0;
            const half = (cgadsub & 0x40) !== 0;
            const fixedColor = this._readFixedColorBgr(lineState);

            for (let x = 0; x < SNES_WIDTH; x += 1) {
                const pixelIndex = (y * SNES_WIDTH) + x;
                let mainColor = mainScreen.colors[pixelIndex];
                let mainSource = mainScreen.sources[pixelIndex];
                let objMathEligible = mainScreen.objMathEligible[pixelIndex] !== 0;
                const subColor = subScreen.colors[pixelIndex];
                const colorWindow = this._isColorWindowMatch(x, lineState);

                if (this._windowRegionMatches(clipMode, colorWindow)) {
                    mainColor = 0;
                    mainSource = LAYER_BACKDROP;
                    objMathEligible = true;
                }

                const subTransparent = this._windowRegionMatches(
                    preventMode,
                    colorWindow,
                );
                const mathEnabled = this._isColorMathEnabledForSource(
                    mainSource,
                    objMathEligible,
                    cgadsub,
                );

                if (mathEnabled) {
                    if (addSubscreen) {
                        if (!subTransparent) {
                            mainColor = this._blendBgr555(
                                mainColor,
                                subColor,
                                subtract,
                                half,
                            );
                        }
                    } else {
                        mainColor = this._blendBgr555(
                            mainColor,
                            fixedColor,
                            subtract,
                            half,
                        );
                    }
                }

                this.frameBuffer[pixelIndex] = bgr555ToRgba(mainColor, brightness);
            }
        }
    }

    _blendBgr555(baseColor, addendColor, subtract, half) {
        const baseR = baseColor & 0x1f;
        const baseG = (baseColor >>> 5) & 0x1f;
        const baseB = (baseColor >>> 10) & 0x1f;
        const addR = addendColor & 0x1f;
        const addG = (addendColor >>> 5) & 0x1f;
        const addB = (addendColor >>> 10) & 0x1f;
        let outR = 0;
        let outG = 0;
        let outB = 0;

        if (!subtract) {
            outB = baseB + addB;
            outG = baseG + addG;
            outR = baseR + addR;
        } else {
            outB = baseB - addB;
            outG = baseG - addG;
            outR = baseR - addR;
        }

        if (half) {
            outB >>= 1;
            outG >>= 1;
            outR >>= 1;
        }

        if (outB < 0) {
            outB = 0;
        } else if (outB > 31) {
            outB = 31;
        }

        if (outG < 0) {
            outG = 0;
        } else if (outG > 31) {
            outG = 31;
        }

        if (outR < 0) {
            outR = 0;
        } else if (outR > 31) {
            outR = 31;
        }

        return outR | (outG << 5) | (outB << 10);
    }

    _windowRegionMatches(mode, inWindow) {
        if (mode === 0) {
            return false;
        }

        if (mode === 1) {
            return !inWindow;
        }

        if (mode === 2) {
            return inWindow;
        }

        return true;
    }

    _isColorWindowMatch(x, lineState = null) {
        const source = lineState?.windowSel25 ?? this.registers[0x25];
        const win1 = this._windowMatch(
            x,
            1,
            (source & 0x10) !== 0,
            (source & 0x20) !== 0,
            lineState,
        );
        const win2 = this._windowMatch(
            x,
            2,
            (source & 0x40) !== 0,
            (source & 0x80) !== 0,
            lineState,
        );

        return this._combineWindows(5, win1, win2, lineState);
    }

    _isColorMathEnabledForSource(source, objMathEligible, cgadsub) {
        if (source === LAYER_BG1) {
            return (cgadsub & 0x01) !== 0;
        }

        if (source === LAYER_BG2) {
            return (cgadsub & 0x02) !== 0;
        }

        if (source === LAYER_BG3) {
            return (cgadsub & 0x04) !== 0;
        }

        if (source === LAYER_BG4) {
            return (cgadsub & 0x08) !== 0;
        }

        if (source === LAYER_OBJ) {
            return objMathEligible && (cgadsub & 0x10) !== 0;
        }

        return (cgadsub & 0x20) !== 0;
    }

    _readFixedColorBgr(lineState = null) {
        const blue = lineState?.fixedColorB ?? this.fixedColorB;
        const green = lineState?.fixedColorG ?? this.fixedColorG;
        const red = lineState?.fixedColorR ?? this.fixedColorR;

        return (
            (red & 0x1f) |
            ((green & 0x1f) << 5) |
            ((blue & 0x1f) << 10)
        ) & 0x7fff;
    }

    _readModePriorities(modeRegister) {
        const mode = modeRegister & 0x07;

        if (mode === 1) {
            if ((modeRegister & 0x08) !== 0) {
                return {
                    bg1Low: 5,
                    bg1High: 8,
                    bg2Low: 4,
                    bg2High: 7,
                    bg3Low: 2,
                    bg3High: 10,
                    obj: [1, 3, 6, 9],
                };
            }

            return {
                bg1Low: 5,
                bg1High: 8,
                bg2Low: 4,
                bg2High: 7,
                bg3Low: 0,
                bg3High: 2,
                obj: [1, 3, 6, 9],
            };
        }

        return {
            bg1Low: 2,
            bg1High: 5,
            bg2Low: 1,
            bg2High: 4,
            bg3Low: 0,
            bg3High: 3,
            obj: [6, 7, 8, 9],
        };
    }

    _renderBG1(target) {
        const bg1sc = this.registers[0x07];
        const bg12nba = this.registers[0x0b];
        const tileMapBase = (bg1sc & 0xfc) << 9;
        const tileDataBase = (bg12nba & 0x0f) << 13;
        const screenSize = bg1sc & 0x03;
        const widthTiles = (screenSize & 0x01) !== 0 ? 64 : 32;
        const heightTiles = (screenSize & 0x02) !== 0 ? 64 : 32;
        const mapMask = (heightTiles * 8) - 1;
        const rowMask = (widthTiles * 8) - 1;

        for (let y = 0; y < SNES_HEIGHT; y += 1) {
            const lineState = this.scanlineState[y];
            const modeRegister = lineState?.bgMode ?? this.registers[0x05];
            const mode = modeRegister & 0x07;
            const tm = target.subscreen
                ? (lineState?.tmSub ?? this.registers[0x2d])
                : (lineState?.tmMain ?? this.registers[0x2c]);

            if ((tm & 0x01) === 0 || (mode !== 0 && mode !== 1)) {
                continue;
            }

            const priorities = this._readModePriorities(modeRegister);
            const lowPriority = priorities.bg1Low;
            const highPriority = priorities.bg1High;
            const hofs = lineState?.bg1Hofs ?? this.bg1Hofs;
            const vofs = lineState?.bg1Vofs ?? this.bg1Vofs;
            const mapY = (y + vofs) & mapMask;
            const tileY = mapY >> 3;
            const pixelY = mapY & 0x07;

            for (let x = 0; x < SNES_WIDTH; x += 1) {
                const mapX = (x + hofs) & rowMask;
                const tileX = mapX >> 3;
                const pixelX = mapX & 0x07;
                const tileEntry = this._readTileMapEntry(
                    tileMapBase,
                    widthTiles,
                    tileX,
                    tileY,
                );
                const tileIndex = tileEntry & 0x03ff;
                const palette = (tileEntry >>> 10) & 0x07;
                const highPriorityTile = (tileEntry & 0x2000) !== 0;
                const hFlip = (tileEntry & 0x4000) !== 0;
                const vFlip = (tileEntry & 0x8000) !== 0;
                const color = this._readTilePixel4bpp(
                    tileDataBase,
                    tileIndex,
                    hFlip ? (7 - pixelX) : pixelX,
                    vFlip ? (7 - pixelY) : pixelY,
                );

                if (color === 0) {
                    continue;
                }

                if (!this._isLayerWindowVisible(
                    0,
                    x,
                    lineState,
                    target.subscreen,
                )) {
                    continue;
                }

                const paletteIndex = (palette * 16) + color;
                const pixelIndex = (y * SNES_WIDTH) + x;
                const priority = highPriorityTile
                    ? highPriority
                    : lowPriority;
                this._writeLayerPixel(
                    target,
                    pixelIndex,
                    paletteIndex,
                    priority,
                    LAYER_BG1,
                );
            }
        }
    }

    _renderBG2(target) {
        const bg2sc = this.registers[0x08];
        const bg12nba = this.registers[0x0b];
        const tileMapBase = (bg2sc & 0xfc) << 9;
        const tileDataBase = ((bg12nba >>> 4) & 0x0f) << 13;
        const screenSize = bg2sc & 0x03;
        const widthTiles = (screenSize & 0x01) !== 0 ? 64 : 32;
        const heightTiles = (screenSize & 0x02) !== 0 ? 64 : 32;
        const mapMask = (heightTiles * 8) - 1;
        const rowMask = (widthTiles * 8) - 1;

        for (let y = 0; y < SNES_HEIGHT; y += 1) {
            const lineState = this.scanlineState[y];
            const modeRegister = lineState?.bgMode ?? this.registers[0x05];
            const mode = modeRegister & 0x07;
            const tm = target.subscreen
                ? (lineState?.tmSub ?? this.registers[0x2d])
                : (lineState?.tmMain ?? this.registers[0x2c]);

            if ((tm & 0x02) === 0 || (mode !== 0 && mode !== 1)) {
                continue;
            }

            const priorities = this._readModePriorities(modeRegister);
            const lowPriority = priorities.bg2Low;
            const highPriority = priorities.bg2High;
            const hofs = lineState?.bg2Hofs ?? this.bg2Hofs;
            const vofs = lineState?.bg2Vofs ?? this.bg2Vofs;
            const mapY = (y + vofs) & mapMask;
            const tileY = mapY >> 3;
            const pixelY = mapY & 0x07;

            for (let x = 0; x < SNES_WIDTH; x += 1) {
                const mapX = (x + hofs) & rowMask;
                const tileX = mapX >> 3;
                const pixelX = mapX & 0x07;
                const tileEntry = this._readTileMapEntry(
                    tileMapBase,
                    widthTiles,
                    tileX,
                    tileY,
                );
                const tileIndex = tileEntry & 0x03ff;
                const palette = (tileEntry >>> 10) & 0x07;
                const highPriorityTile = (tileEntry & 0x2000) !== 0;
                const hFlip = (tileEntry & 0x4000) !== 0;
                const vFlip = (tileEntry & 0x8000) !== 0;
                const color = this._readTilePixel4bpp(
                    tileDataBase,
                    tileIndex,
                    hFlip ? (7 - pixelX) : pixelX,
                    vFlip ? (7 - pixelY) : pixelY,
                );

                if (color === 0) {
                    continue;
                }

                if (!this._isLayerWindowVisible(
                    1,
                    x,
                    lineState,
                    target.subscreen,
                )) {
                    continue;
                }

                const paletteIndex = (palette * 16) + color;
                const pixelIndex = (y * SNES_WIDTH) + x;
                const priority = highPriorityTile
                    ? highPriority
                    : lowPriority;
                this._writeLayerPixel(
                    target,
                    pixelIndex,
                    paletteIndex,
                    priority,
                    LAYER_BG2,
                );
            }
        }
    }

    _renderBG3(target) {
        const bg3sc = this.registers[0x09];
        const bg34nba = this.registers[0x0c];
        const tileMapBase = (bg3sc & 0xfc) << 9;
        const tileDataBase = (bg34nba & 0x0f) << 13;
        const screenSize = bg3sc & 0x03;
        const widthTiles = (screenSize & 0x01) !== 0 ? 64 : 32;
        const heightTiles = (screenSize & 0x02) !== 0 ? 64 : 32;
        const mapMask = (heightTiles * 8) - 1;
        const rowMask = (widthTiles * 8) - 1;

        for (let y = 0; y < SNES_HEIGHT; y += 1) {
            const lineState = this.scanlineState[y];
            const modeRegister = lineState?.bgMode ?? this.registers[0x05];
            const mode = modeRegister & 0x07;
            const tm = target.subscreen
                ? (lineState?.tmSub ?? this.registers[0x2d])
                : (lineState?.tmMain ?? this.registers[0x2c]);

            if ((tm & 0x04) === 0 || mode !== 1) {
                continue;
            }

            const priorities = this._readModePriorities(modeRegister);
            const lowPriority = priorities.bg3Low;
            const highPriority = priorities.bg3High;
            const hofs = lineState?.bg3Hofs ?? this.bg3Hofs;
            const vofs = lineState?.bg3Vofs ?? this.bg3Vofs;
            const mapY = (y + vofs) & mapMask;
            const tileY = mapY >> 3;
            const pixelY = mapY & 0x07;

            for (let x = 0; x < SNES_WIDTH; x += 1) {
                const mapX = (x + hofs) & rowMask;
                const tileX = mapX >> 3;
                const pixelX = mapX & 0x07;
                const tileEntry = this._readTileMapEntry(
                    tileMapBase,
                    widthTiles,
                    tileX,
                    tileY,
                );
                const tileIndex = tileEntry & 0x03ff;
                const palette = (tileEntry >>> 10) & 0x07;
                const highPriorityTile = (tileEntry & 0x2000) !== 0;
                const hFlip = (tileEntry & 0x4000) !== 0;
                const vFlip = (tileEntry & 0x8000) !== 0;
                const color = this._readTilePixel2bpp(
                    tileDataBase,
                    tileIndex,
                    hFlip ? (7 - pixelX) : pixelX,
                    vFlip ? (7 - pixelY) : pixelY,
                );

                if (color === 0) {
                    continue;
                }

                if (!this._isLayerWindowVisible(
                    2,
                    x,
                    lineState,
                    target.subscreen,
                )) {
                    continue;
                }

                const paletteIndex = (palette * 4) + color;
                const pixelIndex = (y * SNES_WIDTH) + x;
                const priority = highPriorityTile
                    ? highPriority
                    : lowPriority;
                this._writeLayerPixel(
                    target,
                    pixelIndex,
                    paletteIndex,
                    priority,
                    LAYER_BG3,
                );
            }
        }
    }

    _renderOBJ(target) {
        const objsel = this.registers[0x01];
        // OBSEL is word-addressed in hardware; convert to byte offsets.
        const tileBase = (objsel & 0x07) << 14;
        const nameSelectOffset = (1 + ((objsel >>> 3) & 0x03)) << 13;
        const sizeConfig = this._readOBJSizeConfig(objsel);

        for (let spriteIndex = 127; spriteIndex >= 0; spriteIndex -= 1) {
            const entry = spriteIndex * 4;
            const xLow = this.oam[entry + 0];
            const y = this.oam[entry + 1];
            const tileNumber = this.oam[entry + 2];
            const attributes = this.oam[entry + 3];
            const highEntry = 512 + (spriteIndex >>> 2);
            const highShift = (spriteIndex & 0x03) << 1;
            const highBits = (this.oam[highEntry] >>> highShift) & 0x03;
            const x = xLow | ((highBits & 0x01) << 8);
            const sizeFlag = (highBits & 0x02) !== 0;
            const spriteWidth = sizeFlag
                ? sizeConfig.largeWidth
                : sizeConfig.smallWidth;
            const spriteHeight = sizeFlag
                ? sizeConfig.largeHeight
                : sizeConfig.smallHeight;
            const signedX = x >= 256 ? x - 512 : x;
            const hFlip = (attributes & 0x40) !== 0;
            const vFlip = (attributes & 0x80) !== 0;
            const palette = (attributes >>> 1) & 0x07;
            const objPriorityLevel = (attributes >>> 4) & 0x03;
            const nameSelect = attributes & 0x01;
            const spriteTileBase = nameSelect
                ? ((tileBase + nameSelectOffset) & 0xffff)
                : (tileBase & 0xffff);
            const characterXBase = tileNumber & 0x0f;

            for (let localY = 0; localY < spriteHeight; localY += 1) {
                const screenY = (y + localY) & 0xff;
                const lineState = screenY < SNES_HEIGHT
                    ? this.scanlineState[screenY]
                    : null;

                if (screenY >= SNES_HEIGHT) {
                    continue;
                }

                const modeRegister = lineState?.bgMode ?? this.registers[0x05];
                const priorities = this._readModePriorities(modeRegister);
                const priority = priorities.obj[objPriorityLevel] ?? 0;
                const tm = target.subscreen
                    ? (lineState?.tmSub ?? this.registers[0x2d])
                    : (lineState?.tmMain ?? this.registers[0x2c]);

                if ((tm & 0x10) === 0) {
                    continue;
                }

                for (let localX = 0; localX < spriteWidth; localX += 1) {
                    const screenX = signedX + localX;

                    if (screenX < 0 || screenX >= SNES_WIDTH) {
                        continue;
                    }

                    const pixelX = hFlip
                        ? ((spriteWidth - 1) - localX)
                        : localX;
                    const pixelY = vFlip
                        ? ((spriteHeight - 1) - localY)
                        : localY;
                    const tileX = pixelX >>> 3;
                    const tileY = pixelY >>> 3;
                    const characterY = (((tileNumber >>> 4) + tileY) & 0x0f) << 4;
                    const tileIndex = (
                        characterY +
                        ((characterXBase + tileX) & 0x0f)
                    ) & 0xff;

                    const color = this._readTilePixel4bpp(
                        spriteTileBase,
                        tileIndex,
                        pixelX & 0x07,
                        pixelY & 0x07,
                    );

                    if (color === 0) {
                        continue;
                    }

                    if (!this._isLayerWindowVisible(
                        4,
                        screenX,
                        lineState,
                        target.subscreen,
                    )) {
                        continue;
                    }

                    const paletteIndex = 128 + (palette * 16) + color;
                    const pixelIndex = (screenY * SNES_WIDTH) + screenX;
                    this._writeLayerPixel(
                        target,
                        pixelIndex,
                        paletteIndex,
                        priority,
                        LAYER_OBJ,
                        palette >= 4,
                    );
                }
            }
        }
    }

    _readOBJSizeConfig(objsel) {
        const table = [
            [8, 8, 16, 16],
            [8, 8, 32, 32],
            [8, 8, 64, 64],
            [16, 16, 32, 32],
            [16, 16, 64, 64],
            [32, 32, 64, 64],
            [16, 32, 32, 64],
            [16, 32, 32, 32],
        ];
        const index = (objsel >>> 5) & 0x07;
        const selected = table[index] ?? table[0];

        return {
            smallWidth: selected[0],
            smallHeight: selected[1],
            largeWidth: selected[2],
            largeHeight: selected[3],
        };
    }

    _readTileMapEntry(base, widthTiles, tileX, tileY) {
        const screenWidth = widthTiles / 32;
        const screenX = tileX >> 5;
        const screenY = tileY >> 5;
        const screenIndex = (screenY * screenWidth) + screenX;
        const screenBase = base + (screenIndex * 0x800);
        const entryOffset = (((tileY & 31) * 32) + (tileX & 31)) * 2;
        const addr = (screenBase + entryOffset) & 0xffff;
        const low = this.vram[addr];
        const high = this.vram[(addr + 1) & 0xffff];

        return low | (high << 8);
    }

    _readTilePixel4bpp(base, tileIndex, pixelX, pixelY) {
        const tileAddr = (base + (tileIndex * 32)) & 0xffff;
        const rowAddr = tileAddr + (pixelY * 2);
        const bit = 7 - pixelX;
        const plane0 = (this.vram[rowAddr & 0xffff] >> bit) & 0x01;
        const plane1 = (this.vram[(rowAddr + 1) & 0xffff] >> bit) & 0x01;
        const plane2 = (this.vram[(rowAddr + 16) & 0xffff] >> bit) & 0x01;
        const plane3 = (this.vram[(rowAddr + 17) & 0xffff] >> bit) & 0x01;

        return plane0 | (plane1 << 1) | (plane2 << 2) | (plane3 << 3);
    }

    _readTilePixel2bpp(base, tileIndex, pixelX, pixelY) {
        const tileAddr = (base + (tileIndex * 16)) & 0xffff;
        const rowAddr = tileAddr + (pixelY * 2);
        const bit = 7 - pixelX;
        const plane0 = (this.vram[rowAddr & 0xffff] >> bit) & 0x01;
        const plane1 = (this.vram[(rowAddr + 1) & 0xffff] >> bit) & 0x01;

        return plane0 | (plane1 << 1);
    }

    _writeLayerPixel(
        target,
        pixelIndex,
        paletteIndex,
        priority,
        source,
        objMathEligible = true,
    ) {
        if (priority < target.priorities[pixelIndex]) {
            return;
        }

        target.priorities[pixelIndex] = priority;
        target.colors[pixelIndex] = this._readPaletteColorBgr(paletteIndex);
        target.sources[pixelIndex] = source;
        target.objMathEligible[pixelIndex] = objMathEligible ? 1 : 0;
    }

    _isLayerWindowVisible(layer, x, lineState = null, subscreen = false) {
        const tmw = subscreen
            ? (lineState?.windowMaskSub ?? this.registers[0x2f])
            : (lineState?.windowMaskMain ?? this.registers[0x2e]);
        const layerMaskBit = 1 << layer;

        if ((tmw & layerMaskBit) === 0) {
            return true;
        }

        const selection = this._readWindowSelection(layer, lineState);
        const win1 = this._windowMatch(
            x,
            1,
            selection.window1Enabled,
            selection.window1Invert,
            lineState,
        );
        const win2 = this._windowMatch(
            x,
            2,
            selection.window2Enabled,
            selection.window2Invert,
            lineState,
        );
        const result = this._combineWindows(layer, win1, win2, lineState);

        return !result;
    }

    _readWindowSelection(layer, lineState = null) {
        let source = lineState?.windowSel23 ?? this.registers[0x23];
        let shift = 0;

        if (layer === 1) {
            shift = 4;
        } else if (layer === 2) {
            source = lineState?.windowSel24 ?? this.registers[0x24];
            shift = 0;
        } else if (layer === 3) {
            source = lineState?.windowSel24 ?? this.registers[0x24];
            shift = 4;
        } else if (layer === 4) {
            source = lineState?.windowSel25 ?? this.registers[0x25];
            shift = 0;
        } else if (layer === 5) {
            source = lineState?.windowSel25 ?? this.registers[0x25];
            shift = 4;
        }

        return {
            window1Enabled: (source & (1 << shift)) !== 0,
            window1Invert: (source & (1 << (shift + 1))) !== 0,
            window2Enabled: (source & (1 << (shift + 2))) !== 0,
            window2Invert: (source & (1 << (shift + 3))) !== 0,
        };
    }

    _windowMatch(x, windowId, enabled, invert, lineState = null) {
        if (!enabled) {
            return null;
        }

        const left = windowId === 1
            ? (lineState?.windowLeft1 ?? this.registers[0x26])
            : (lineState?.windowLeft2 ?? this.registers[0x28]);
        const right = windowId === 1
            ? (lineState?.windowRight1 ?? this.registers[0x27])
            : (lineState?.windowRight2 ?? this.registers[0x29]);
        let inside = false;

        if (left <= right) {
            inside = x >= left && x <= right;
        } else {
            inside = x >= left || x <= right;
        }

        return invert ? !inside : inside;
    }

    _combineWindows(layer, window1, window2, lineState = null) {
        if (window1 === null && window2 === null) {
            return false;
        }

        if (window1 !== null && window2 === null) {
            return window1;
        }

        if (window1 === null && window2 !== null) {
            return window2;
        }

        let logic = 0;

        if (layer <= 3) {
            const logicSource = lineState?.windowLogicA ?? this.registers[0x2a];
            logic = (logicSource >>> (layer * 2)) & 0x03;
        } else {
            const logicSource = lineState?.windowLogicB ?? this.registers[0x2b];
            logic = (logicSource >>> ((layer - 4) * 2)) & 0x03;
        }

        if (logic === 0) {
            return window1 || window2;
        }

        if (logic === 1) {
            return window1 && window2;
        }

        if (logic === 2) {
            return window1 !== window2;
        }

        return window1 === window2;
    }

    _readPaletteColorBgr(index) {
        const paletteIndex = index & 0xff;
        const low = this.cgram[(paletteIndex * 2) & 0x1ff];
        const high = this.cgram[((paletteIndex * 2) + 1) & 0x1ff];
        return (low | ((high & 0x7f) << 8)) & 0x7fff;
    }

    _readPaletteColor(index, brightness) {
        const color = this._readPaletteColorBgr(index);

        return bgr555ToRgba(color, brightness);
    }
}

export {
    SNESPPU,
    SNES_WIDTH,
    SNES_HEIGHT,
};
