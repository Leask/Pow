function clamp8(value) {
    return Math.max(0, Math.min(255, Math.round(value)));
}
function rgba(value) {
    return [
        value >>> 24,
        (value >>> 16) & 255,
        (value >>> 8) & 255,
        value & 255,
    ];
}
function rgba16(value) {
    return [
        (((value >>> 11) & 31) * 255) / 31,
        (((value >>> 6) & 31) * 255) / 31,
        (((value >>> 1) & 31) * 255) / 31,
        (value & 1) * 255,
    ];
}

class RDP {
    constructor(bus) {
        this.bus = bus;
        this.colorImage = { address: 0, width: 320, size: 2, format: 0 };
        this.textureImage = { address: 0, width: 1, size: 2, format: 0 };
        this.depthAddress = 0;
        this.depth = new Float32Array(640 * 480);
        this.depth.fill(Infinity);
        this.tmem = new Uint8Array(8192);
        this.palette = new Uint16Array(256);
        this.texelCache = new Map();
        this.tiles = Array.from({ length: 8 }, () => ({
            format: 0,
            size: 2,
            line: 0,
            tmem: 0,
            palette: 0,
            sMode: 0,
            tMode: 0,
            sMask: 0,
            tMask: 0,
            sShift: 0,
            tShift: 0,
            sl: 0,
            tl: 0,
            sh: 0,
            th: 0,
        }));
        this.scissor = [0, 0, 320, 240];
        this.otherH = 0;
        this.otherL = 0;
        this.fillColor = 0;
        this.primitive = [255, 255, 255, 255];
        this.environment = [255, 255, 255, 255];
        this.blend = [0, 0, 0, 0];
        this.fog = [0, 0, 0, 0];
        this.primitiveLOD = 0;
        this.primitiveDepth = 0;
        this.combine = [0, 0];
        this.combiner = [
            [0, 0, 0, 4, 0, 0, 0, 4],
            [0, 0, 0, 4, 0, 0, 0, 4],
        ];
        this.fastRGB = 4;
        this.fastAlpha = 4;
        this.pixelColor = [0, 0, 0, 0];
        this.triangles = 0;
        this.rectangles = 0;
        this.pixels = 0;
    }

    setCombine(w0, w1) {
        this.combine = [w0, w1];
        this.combiner = [
            [
                (w0 >>> 20) & 15,
                w1 >>> 28,
                (w0 >>> 15) & 31,
                (w1 >>> 15) & 7,
                (w0 >>> 12) & 7,
                (w1 >>> 12) & 7,
                (w0 >>> 9) & 7,
                (w1 >>> 9) & 7,
            ],
            [
                (w0 >>> 5) & 15,
                (w1 >>> 24) & 15,
                w0 & 31,
                (w1 >>> 6) & 7,
                (w1 >>> 21) & 7,
                (w1 >>> 3) & 7,
                (w1 >>> 18) & 7,
                w1 & 7,
            ],
        ];
        const mux = this.combiner[1];
        this.fastRGB =
            mux[0] === mux[1] || mux[2] >= 16
                ? mux[3]
                : mux[0] === 1 && mux[1] === 15 && mux[2] === 4 && mux[3] === 7
                  ? 8
                  : mux[0] === 3 && mux[1] === 4 && mux[2] === 1 && mux[3] === 4
                    ? 9
                    : -1;
        this.fastAlpha =
            mux[4] === mux[5] || mux[6] === 7
                ? mux[7]
                : mux[4] === 1 && mux[5] === 7 && mux[6] === 4 && mux[7] === 7
                  ? 8
                  : mux[4] === 3 && mux[5] === 4 && mux[6] === 1 && mux[7] === 4
                    ? 9
                    : -1;
    }

    command(w0, w1, resolve = (address) => address & 0x007fffff) {
        const op = w0 >>> 24;
        const tile = this.tiles[(w1 >>> 24) & 7];
        switch (op) {
            case 0xc0:
            case 0xe6:
            case 0xe7:
            case 0xe8:
                break;
            case 0xe9:
                this.bus.raiseInterrupt(32);
                break;
            case 0xed:
                this.scissor = [
                    ((w0 >>> 12) & 4095) / 4,
                    (w0 & 4095) / 4,
                    ((w1 >>> 12) & 4095) / 4,
                    (w1 & 4095) / 4,
                ];
                break;
            case 0xee:
                this.primitiveDepth = (w1 >>> 16) / 32767;
                break;
            case 0xef:
                this.otherH = w0 & 0x00ffffff;
                this.otherL = w1;
                break;
            case 0xf0: {
                this.texelCache.clear();
                const count = ((w1 >>> 14) & 1023) + 1;
                const start = (tile.tmem - 0x100) * 4;
                for (let i = 0; i < count; i += 1) {
                    this.palette[(start + i) & 255] = this.bus.read16(
                        this.textureImage.address + i * 2,
                    );
                }
                break;
            }
            case 0xf2:
                tile.sl = (w0 >>> 12) & 4095;
                tile.tl = w0 & 4095;
                tile.sh = (w1 >>> 12) & 4095;
                tile.th = w1 & 4095;
                break;
            case 0xf3:
                this.loadBlock(tile, w0, w1);
                break;
            case 0xf4:
                this.loadTile(tile, w0, w1);
                break;
            case 0xf5:
                Object.assign(tile, {
                    format: (w0 >>> 21) & 7,
                    size: (w0 >>> 19) & 3,
                    line: (w0 >>> 9) & 511,
                    tmem: w0 & 511,
                    palette: (w1 >>> 20) & 15,
                    tMode: (w1 >>> 18) & 3,
                    tMask: (w1 >>> 14) & 15,
                    tShift: (w1 >>> 10) & 15,
                    sMode: (w1 >>> 8) & 3,
                    sMask: (w1 >>> 4) & 15,
                    sShift: w1 & 15,
                });
                break;
            case 0xf6:
                this.fillRectangle(w0, w1);
                break;
            case 0xf7:
                this.fillColor = w1;
                break;
            case 0xf8:
                this.fog = rgba(w1);
                break;
            case 0xf9:
                this.blend = rgba(w1);
                break;
            case 0xfa:
                this.primitive = rgba(w1);
                this.primitiveLOD = w0 & 255;
                break;
            case 0xfb:
                this.environment = rgba(w1);
                break;
            case 0xfc:
                this.setCombine(w0, w1);
                break;
            case 0xfd:
                this.textureImage = {
                    address: resolve(w1),
                    width: (w0 & 4095) + 1,
                    size: (w0 >>> 19) & 3,
                    format: (w0 >>> 21) & 7,
                };
                break;
            case 0xfe:
                this.depthAddress = resolve(w1);
                break;
            case 0xff:
                this.colorImage = {
                    address: resolve(w1),
                    width: (w0 & 4095) + 1,
                    size: (w0 >>> 19) & 3,
                    format: (w0 >>> 21) & 7,
                };
                break;
            default:
                throw new Error(`Unsupported RDP command 0x${op.toString(16)}`);
        }
    }

    loadBlock(tile, w0, w1) {
        this.texelCache.clear();
        const image = this.textureImage;
        const size = 0.5 * 2 ** image.size;
        const s = (w0 >>> 12) & 4095;
        const t = w0 & 4095;
        const count = ((w1 >>> 12) & 4095) + 1;
        const source = image.address + Math.floor((t * image.width + s) * size);
        const bytes = Math.ceil(count * size);
        for (let i = 0; i < bytes; i += 1) {
            this.tmem[(tile.tmem * 8 + i) & 8191] = this.bus.read8(source + i);
        }
    }

    loadTile(tile, w0, w1) {
        this.texelCache.clear();
        const image = this.textureImage;
        const sl = ((w0 >>> 12) & 4095) >>> 2;
        const tl = (w0 & 4095) >>> 2;
        const sh = ((w1 >>> 12) & 4095) >>> 2;
        const th = (w1 & 4095) >>> 2;
        const size = 0.5 * 2 ** image.size;
        const rowBytes = Math.ceil((sh - sl + 1) * size);
        for (let y = tl; y <= th; y += 1) {
            const source =
                image.address + Math.floor((y * image.width + sl) * size);
            const destination = tile.tmem * 8 + (y - tl) * tile.line * 8;
            for (let i = 0; i < rowBytes; i += 1) {
                this.tmem[(destination + i) & 8191] = this.bus.read8(
                    source + i,
                );
            }
        }
    }

    coordinate(value, axis) {
        let v = value * axis.scale - axis.origin;
        if (axis.clamp) v = Math.max(0, Math.min(axis.high, v));
        v = Math.floor(v);
        if (axis.mask) {
            const mirror = axis.mirror && v & axis.extent;
            v &= axis.extent - 1;
            if (mirror) v = axis.extent - 1 - v;
        }
        return v;
    }

    prepareTexture(tileIndex) {
        const tile = this.tiles[tileIndex & 7];
        const key = [
            tile.format,
            tile.size,
            tile.line,
            tile.tmem,
            tile.palette,
            tile.sl,
            tile.sh,
            tile.tl,
            tile.th,
            tile.sShift,
            tile.tShift,
            tile.sMask,
            tile.tMask,
            tile.sMode,
            tile.tMode,
            (this.otherH >>> 14) & 3,
        ].join(',');
        let sampler = this.texelCache.get(key);
        if (sampler) return sampler;
        const texelSize = 0.5 * 2 ** tile.size;
        const axis = (low, high, shift, mask, mode) => ({
            scale: 2 ** (shift <= 10 ? -shift : 16 - shift),
            origin: low / 4,
            high: (high - low) / 4,
            clamp: (mode & 2) !== 0,
            mirror: (mode & 1) !== 0,
            mask,
            extent: 2 ** mask,
        });
        sampler = {
            tile: { ...tile },
            texelSize,
            line:
                tile.line * 8 ||
                Math.ceil(((tile.sh - tile.sl) / 4 + 1) * texelSize),
            base: tile.tmem * 8,
            colors: [],
            s: axis(tile.sl, tile.sh, tile.sShift, tile.sMask, tile.sMode),
            t: axis(tile.tl, tile.th, tile.tShift, tile.tMask, tile.tMode),
        };
        this.texelCache.set(key, sampler);
        return sampler;
    }

    texture(tileIndex, s, t, sampler = this.prepareTexture(tileIndex)) {
        const tile = sampler.tile;
        const x = this.coordinate(s, sampler.s);
        const y = this.coordinate(t, sampler.t);
        const address =
            (sampler.base +
                y * sampler.line +
                Math.floor(x * sampler.texelSize)) &
            8191;
        const key = address * 2 + (x & 1);
        const cached = sampler.colors[key];
        if (cached) return cached;
        const color = this.decodeTexel(tile, address, x);
        sampler.colors[key] = color;
        return color;
    }

    decodeTexel(tile, address, x) {
        const byte = this.tmem[address];
        const next = this.tmem[(address + 1) & 8191];
        if (tile.format === 0) {
            if (tile.size === 2) return rgba16((byte << 8) | next);
            if (tile.size === 3)
                return [
                    byte,
                    next,
                    this.tmem[(address + 2) & 8191],
                    this.tmem[(address + 3) & 8191],
                ];
        }
        if (tile.format === 2) {
            const index =
                tile.size === 0
                    ? tile.palette * 16 + (x & 1 ? byte & 15 : byte >>> 4)
                    : byte;
            const color = this.palette[index];
            if (((this.otherH >>> 14) & 3) === 3) {
                return [color >>> 8, color >>> 8, color >>> 8, color & 255];
            }
            return rgba16(color);
        }
        if (tile.format === 3) {
            if (tile.size === 0) {
                const nibble = x & 1 ? byte & 15 : byte >>> 4;
                const intensity = ((nibble >>> 1) * 255) / 7;
                return [intensity, intensity, intensity, (nibble & 1) * 255];
            }
            const intensity = tile.size === 1 ? (byte >>> 4) * 17 : byte;
            return [
                intensity,
                intensity,
                intensity,
                tile.size === 1 ? (byte & 15) * 17 : next,
            ];
        }
        if (tile.format === 4) {
            const intensity =
                tile.size === 0 ? (x & 1 ? byte & 15 : byte >>> 4) * 17 : byte;
            return [intensity, intensity, intensity, intensity];
        }
        throw new Error(
            `Unsupported texture format ${tile.format}/${tile.size}`,
        );
    }

    combineColor(shade, texel) {
        const cycles = (this.otherH >>> 20) & 3;
        if (cycles === 2) return texel;
        if (cycles !== 1 && this.fastRGB > 0 && this.fastAlpha > 0) {
            const result = this.pixelColor;
            for (let channel = 0; channel < 4; channel += 1) {
                const mode = channel === 3 ? this.fastAlpha : this.fastRGB;
                result[channel] =
                    mode < 3
                        ? texel[channel]
                        : mode === 3
                          ? this.primitive[channel]
                          : mode === 4
                            ? shade[channel]
                            : mode === 5
                              ? this.environment[channel]
                              : mode === 9
                                ? ((this.primitive[channel] - shade[channel]) *
                                      texel[channel]) /
                                      255 +
                                  shade[channel]
                                : mode === 8
                                  ? (shade[channel] * texel[channel]) / 255
                                  : mode === 6
                                    ? 255
                                    : 0;
            }
            return result;
        }
        let combined = [0, 0, 0, 0];
        const first = cycles === 1 ? 0 : 1;
        for (let cycle = first; cycle < 2; cycle += 1) {
            const mux = this.combiner[cycle];
            const sources = [
                combined,
                texel,
                texel,
                this.primitive,
                shade,
                this.environment,
            ];
            const basic = (selector, channel) =>
                selector < 6
                    ? sources[selector][channel]
                    : selector === 6
                      ? 255
                      : 0;
            const factor = (selector, channel) =>
                selector < 6
                    ? sources[selector][channel]
                    : selector >= 7 && selector <= 12
                      ? sources[selector - 7][3]
                      : selector === 14
                        ? this.primitiveLOD
                        : 0;
            const next = [0, 0, 0, 0];
            for (let channel = 0; channel < 3; channel += 1) {
                next[channel] = clamp8(
                    ((basic(mux[0], channel) - basic(mux[1], channel)) *
                        factor(mux[2], channel)) /
                        255 +
                        basic(mux[3], channel),
                );
            }
            const alphaFactor =
                mux[6] === 0
                    ? 0
                    : mux[6] === 6
                      ? this.primitiveLOD
                      : basic(mux[6], 3);
            next[3] = clamp8(
                ((basic(mux[4], 3) - basic(mux[5], 3)) * alphaFactor) / 255 +
                    basic(mux[7], 3),
            );
            combined = next;
        }
        return combined;
    }

    writePixel(x, y, color, depth = 0, zEnabled = false) {
        const image = this.colorImage;
        if (x < 0 || y < 0 || x >= image.width || y >= 480) return;
        const index = y * image.width + x;
        if (zEnabled && this.otherL & 16 && depth > this.depth[index] + 0.00001)
            return;
        const alpha = clamp8(color[3]);
        if (this.otherL & 1 && alpha < this.blend[3]) return;
        if (alpha === 0) return;
        const address = image.address + index * (image.size === 3 ? 4 : 2);
        if (address < 0 || address + 4 > this.bus.ram.length) return;
        let r = clamp8(color[0]);
        let g = clamp8(color[1]);
        let b = clamp8(color[2]);
        if (this.otherL & 0x4000 && alpha < 255) {
            const old =
                image.size === 3
                    ? rgba(this.bus.read32(address))
                    : rgba16(this.bus.read16(address));
            r = clamp8((r * alpha + old[0] * (255 - alpha)) / 255);
            g = clamp8((g * alpha + old[1] * (255 - alpha)) / 255);
            b = clamp8((b * alpha + old[2] * (255 - alpha)) / 255);
        }
        if (image.size === 3)
            this.bus.write32(address, (r << 24) | (g << 16) | (b << 8) | 255);
        else
            this.bus.write16(
                address,
                ((r >>> 3) << 11) | ((g >>> 3) << 6) | ((b >>> 3) << 1) | 1,
            );
        if (zEnabled && this.otherL & 32) this.depth[index] = depth;
        this.pixels += 1;
    }

    rectangleBounds(w0, w1) {
        const inclusive = ((this.otherH >>> 20) & 3) >= 2 ? 1 : 0;
        return [
            Math.max(this.scissor[0], ((w1 >>> 12) & 4095) / 4),
            Math.max(this.scissor[1], (w1 & 4095) / 4),
            Math.min(this.scissor[2], ((w0 >>> 12) & 4095) / 4 + inclusive),
            Math.min(this.scissor[3], (w0 & 4095) / 4 + inclusive),
        ];
    }

    fillRectangle(w0, w1) {
        this.rectangles += 1;
        const [x0, y0, x1, y1] = this.rectangleBounds(w0, w1);
        const fill = ((this.otherH >>> 20) & 3) === 3;
        for (let y = Math.ceil(y0); y < y1; y += 1) {
            for (let x = Math.ceil(x0); x < x1; x += 1) {
                if (this.colorImage.address === this.depthAddress) {
                    this.depth[y * this.colorImage.width + x] = Infinity;
                    this.bus.write16(
                        this.depthAddress + (y * this.colorImage.width + x) * 2,
                        x & 1 ? this.fillColor & 65535 : this.fillColor >>> 16,
                    );
                    continue;
                }
                if (fill) {
                    // Fill cycle bypasses alpha comparison, blending and Z.
                    const size = this.colorImage.size === 3 ? 4 : 2;
                    const address =
                        this.colorImage.address +
                        (y * this.colorImage.width + x) * size;
                    if (size === 4) this.bus.write32(address, this.fillColor);
                    else
                        this.bus.write16(
                            address,
                            x & 1
                                ? this.fillColor & 65535
                                : this.fillColor >>> 16,
                        );
                    this.pixels += 1;
                } else {
                    this.writePixel(
                        x,
                        y,
                        this.combineColor(
                            [255, 255, 255, 255],
                            [255, 255, 255, 255],
                        ),
                    );
                }
            }
        }
    }

    textureRectangle(w0, w1, st, derivatives, flip = false) {
        this.rectangles += 1;
        const [x0, y0, x1, y1] = this.rectangleBounds(w0, w1);
        const tile = (w1 >>> 24) & 7;
        const originX = ((w1 >>> 12) & 4095) / 4;
        const originY = (w1 & 4095) / 4;
        const s = (st >> 16) / 32;
        const t = ((st << 16) >> 16) / 32;
        const dsdx =
            (derivatives >> 16) /
            1024 /
            (((this.otherH >>> 20) & 3) === 2 ? 4 : 1);
        const dtdy = ((derivatives << 16) >> 16) / 1024;
        const sampler = this.prepareTexture(tile);
        const opaqueCopy =
            ((this.otherH >>> 20) & 3) === 0 &&
            (this.fastRGB === 1 || this.fastRGB === 2) &&
            (this.fastAlpha === 4 || this.fastAlpha === 6) &&
            this.colorImage.size === 2;
        if (
            opaqueCopy &&
            sampler.tile.format === 0 &&
            sampler.tile.size === 2 &&
            !flip
        ) {
            this.copyRGBA16Rectangle(
                sampler,
                [x0, y0, x1, y1],
                [s, t, originX, originY, dsdx, dtdy],
            );
            return;
        }
        const white = [255, 255, 255, 255];
        for (let y = Math.ceil(y0); y < y1; y += 1) {
            for (let x = Math.ceil(x0); x < x1; x += 1) {
                const texel = this.texture(
                    tile,
                    s + (flip ? y - originY : x - originX) * dsdx,
                    t + (flip ? x - originX : y - originY) * dtdy,
                    sampler,
                );
                if (opaqueCopy) {
                    const address =
                        this.colorImage.address +
                        (y * this.colorImage.width + x) * 2;
                    if (
                        x >= 0 &&
                        x < this.colorImage.width &&
                        y >= 0 &&
                        y < 480 &&
                        address >= 0 &&
                        address + 4 <= this.bus.ram.length
                    ) {
                        this.bus.ramView.setUint16(
                            address,
                            ((clamp8(texel[0]) >>> 3) << 11) |
                                ((clamp8(texel[1]) >>> 3) << 6) |
                                ((clamp8(texel[2]) >>> 3) << 1) |
                                1,
                        );
                        this.pixels += 1;
                    }
                    continue;
                }
                this.writePixel(x, y, this.combineColor(white, texel));
            }
        }
    }

    copyRGBA16Rectangle(sampler, bounds, coordinates) {
        const [x0, y0, x1, y1] = bounds;
        const [s, t, originX, originY, dsdx, dtdy] = coordinates;
        const minX = Math.max(0, Math.ceil(x0));
        const maxX = Math.min(this.colorImage.width, Math.ceil(x1));
        const minY = Math.max(0, Math.ceil(y0));
        const maxY = Math.min(480, Math.ceil(y1));
        if (maxX <= minX || maxY <= minY) return;
        const columns = new Int32Array(maxX - minX);
        for (let x = minX; x < maxX; x += 1) {
            columns[x - minX] =
                this.coordinate(s + (x - originX) * dsdx, sampler.s) * 2;
        }
        for (let y = minY; y < maxY; y += 1) {
            const row =
                sampler.base +
                this.coordinate(t + (y - originY) * dtdy, sampler.t) *
                    sampler.line;
            let destination =
                this.colorImage.address +
                (y * this.colorImage.width + minX) * 2;
            for (let x = 0; x < columns.length; x += 1, destination += 2) {
                if (destination < 0 || destination + 4 > this.bus.ram.length) {
                    continue;
                }
                const address = (row + columns[x]) & 8191;
                const color =
                    (this.tmem[address] << 8) |
                    this.tmem[(address + 1) & 8191] |
                    1;
                this.bus.ramView.setUint16(destination, color);
                this.pixels += 1;
            }
        }
    }

    triangle(v0, v1, v2, texture, tile, geometryMode) {
        this.triangles += 1;
        const edge = (a, b, x, y) =>
            (x - a.x) * (b.y - a.y) - (y - a.y) * (b.x - a.x);
        const area = edge(v0, v1, v2.x, v2.y);
        if (!Number.isFinite(area) || Math.abs(area) < 1e-8) return;
        if (geometryMode & 0x1000 && area > 0) return;
        if (geometryMode & 0x2000 && area < 0) return;
        const minX = Math.max(
            0,
            Math.ceil(this.scissor[0]),
            Math.floor(Math.min(v0.x, v1.x, v2.x)),
        );
        const maxX = Math.min(
            this.colorImage.width - 1,
            Math.ceil(this.scissor[2]) - 1,
            Math.ceil(Math.max(v0.x, v1.x, v2.x)),
        );
        const minY = Math.max(
            0,
            Math.ceil(this.scissor[1]),
            Math.floor(Math.min(v0.y, v1.y, v2.y)),
        );
        const maxY = Math.min(
            479,
            Math.ceil(this.scissor[3]) - 1,
            Math.ceil(Math.max(v0.y, v1.y, v2.y)),
        );
        const invArea = 1 / area;
        const perspective = (this.otherH & 0x80000) !== 0;
        const flatShade =
            !(geometryMode & 0x200) ||
            v0.color.every(
                (value, index) =>
                    value === v1.color[index] && value === v2.color[index],
            );
        const shade = flatShade ? v0.color : [0, 0, 0, 0];
        const white = [255, 255, 255, 255];
        const sampler = texture ? this.prepareTexture(tile) : null;
        const zEnabled = (geometryMode & 1) !== 0;
        const zCompare = zEnabled && (this.otherL & 16) !== 0;
        const iw0 = 1 / v0.w;
        const iw1 = 1 / v1.w;
        const iw2 = 1 / v2.w;
        const su0 = v0.s * iw0;
        const su1 = v1.s * iw1;
        const su2 = v2.s * iw2;
        const tv0 = v0.t * iw0;
        const tv1 = v1.t * iw1;
        const tv2 = v2.t * iw2;
        const da = (v2.y - v1.y) * invArea;
        const db = (v0.y - v2.y) * invArea;
        for (let y = minY; y <= maxY; y += 1) {
            let a = edge(v1, v2, minX + 0.5, y + 0.5) * invArea;
            let b = edge(v2, v0, minX + 0.5, y + 0.5) * invArea;
            for (let x = minX; x <= maxX; x += 1, a += da, b += db) {
                const c = 1 - a - b;
                if (a < -1e-8 || b < -1e-8 || c < -1e-8) continue;
                const z =
                    this.otherL & 4
                        ? this.primitiveDepth
                        : a * v0.z + b * v1.z + c * v2.z;
                if (
                    zCompare &&
                    z > this.depth[y * this.colorImage.width + x] + 0.00001
                ) {
                    continue;
                }
                if (!flatShade) {
                    for (let i = 0; i < 4; i += 1) {
                        shade[i] =
                            a * v0.color[i] + b * v1.color[i] + c * v2.color[i];
                    }
                }
                let texel = white;
                if (texture) {
                    const w = perspective ? a * iw0 + b * iw1 + c * iw2 : 1;
                    const u = perspective
                        ? (a * su0 + b * su1 + c * su2) / w
                        : a * v0.s + b * v1.s + c * v2.s;
                    const v = perspective
                        ? (a * tv0 + b * tv1 + c * tv2) / w
                        : a * v0.t + b * v1.t + c * v2.t;
                    texel = this.texture(tile, u, v, sampler);
                }
                const color = this.combineColor(shade, texel);
                this.writePixel(x, y, color, z, zEnabled);
            }
        }
    }
}

export { RDP, rgba16 };
