import { RDP } from './rdp.mjs';

function identity() {
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}
function multiply(a, b) {
    const out = new Array(16).fill(0);
    for (let row = 0; row < 4; row += 1) {
        for (let col = 0; col < 4; col += 1) {
            for (let i = 0; i < 4; i += 1)
                out[row * 4 + col] += a[row * 4 + i] * b[i * 4 + col];
        }
    }
    return out;
}
function transform(v, matrix) {
    const out = new Array(4);
    for (let col = 0; col < 4; col += 1) {
        out[col] =
            v[0] * matrix[col] +
            v[1] * matrix[4 + col] +
            v[2] * matrix[8 + col] +
            v[3] * matrix[12 + col];
    }
    return out;
}
function signed16(value) {
    return (value << 16) >> 16;
}
function signed8(value) {
    return (value << 24) >> 24;
}
function normalize(v) {
    const length = Math.hypot(...v) || 1;
    return v.map((value) => value / length);
}

class RSPGraphics {
    constructor(bus) {
        this.bus = bus;
        this.rdp = new RDP(bus);
        this.segments = new Uint32Array(16);
        this.projection = identity();
        this.modelview = [identity()];
        this.combined = identity();
        this.vertices = new Array(80);
        this.viewport = { scale: [160, 120, 511], translate: [160, 120, 511] };
        this.geometryMode = 0;
        this.textureEnabled = false;
        this.textureTile = 0;
        this.textureScale = [1, 1];
        this.numLights = 0;
        this.lights = Array.from({ length: 8 }, () => ({
            color: [0, 0, 0],
            dir: [0, 0, 1],
        }));
        this.lookAt = [
            [1, 0, 0],
            [0, 1, 0],
        ];
        this.commands = new Uint32Array(256);
        this.tasks = 0;
        this.trace = [];
    }

    address(value) {
        return (
            (this.segments[(value >>> 24) & 15] + (value & 0x00ffffff)) &
            0x007fffff
        );
    }

    readMatrix(address) {
        return Array.from(
            { length: 16 },
            (_, i) =>
                signed16(this.bus.read16(address + i * 2)) +
                this.bus.read16(address + 32 + i * 2) / 65536,
        );
    }

    updateMatrix() {
        this.combined = multiply(this.modelview.at(-1), this.projection);
    }

    matrix(flags, address) {
        const value = this.readMatrix(address);
        if (flags & 1)
            this.projection =
                flags & 2 ? value : multiply(value, this.projection);
        else {
            if (flags & 4) this.modelview.push(this.modelview.at(-1).slice());
            if (this.modelview.length > 32)
                throw new Error('RSP modelview stack overflow.');
            const current = this.modelview.length - 1;
            this.modelview[current] =
                flags & 2 ? value : multiply(value, this.modelview[current]);
        }
        this.updateMatrix();
    }

    moveMemory(index, address) {
        if (index === 0x80) {
            this.viewport.scale = [0, 1, 2].map(
                (i) => signed16(this.bus.read16(address + i * 2)) / 4,
            );
            this.viewport.translate = [0, 1, 2].map(
                (i) => signed16(this.bus.read16(address + 8 + i * 2)) / 4,
            );
        } else if (index === 0x82 || index === 0x84) {
            this.lookAt[index === 0x84 ? 0 : 1] = [0, 1, 2].map(
                (i) => signed8(this.bus.read8(address + 8 + i)) / 127,
            );
        } else if (index >= 0x86 && index <= 0x94) {
            this.lights[(index - 0x86) / 2] = {
                color: [0, 1, 2].map((i) => this.bus.read8(address + i)),
                dir: [0, 1, 2].map(
                    (i) => signed8(this.bus.read8(address + 8 + i)) / 127,
                ),
            };
        } else
            throw new Error(
                `Unsupported F3D MOVEMEM index 0x${index.toString(16)}`,
            );
    }

    moveWord(index, offset, value) {
        switch (index) {
            case 2:
                this.numLights = Math.max(
                    0,
                    Math.min(7, ((value & 0x7fffffff) >>> 5) - 1),
                );
                break;
            case 4:
                break; // Floating-point clipping does not need fixed-point guard bands.
            case 6:
                this.segments[(offset >>> 2) & 15] = value & 0x00ffffff;
                break;
            case 8:
                this.fogMultiplier = value >> 16;
                this.fogOffset = signed16(value);
                break;
            case 10: {
                const light = this.lights[Math.floor(offset / 32)];
                if (light)
                    light.color = [
                        value >>> 24,
                        (value >>> 16) & 255,
                        (value >>> 8) & 255,
                    ];
                break;
            }
            case 14:
                break; // Perspective normalization is unnecessary in floating point.
            default:
                throw new Error(`Unsupported F3D MOVEWORD index ${index}`);
        }
    }

    loadVertices(address, first, count) {
        if (first + count > this.vertices.length)
            throw new Error('RSP vertex cache overflow.');
        const model = this.modelview.at(-1);
        for (let i = 0; i < count; i += 1) {
            const p = address + i * 16;
            const clip = transform(
                [
                    signed16(this.bus.read16(p)),
                    signed16(this.bus.read16(p + 2)),
                    signed16(this.bus.read16(p + 4)),
                    1,
                ],
                this.combined,
            );
            const color = [
                this.bus.read8(p + 12),
                this.bus.read8(p + 13),
                this.bus.read8(p + 14),
                this.bus.read8(p + 15),
            ];
            let s =
                (signed16(this.bus.read16(p + 8)) / 32) * this.textureScale[0];
            let t =
                (signed16(this.bus.read16(p + 10)) / 32) * this.textureScale[1];
            if (this.geometryMode & 0x20000) {
                const normal = normalize(color.slice(0, 3).map(signed8));
                const worldNormal = normalize(
                    transform([...normal, 0], model).slice(0, 3),
                );
                const ambient = this.lights[this.numLights].color;
                for (let channel = 0; channel < 3; channel += 1) {
                    color[channel] = ambient[channel];
                }
                for (let light = 0; light < this.numLights; light += 1) {
                    const item = this.lights[light];
                    const dot = Math.max(
                        0,
                        worldNormal[0] * item.dir[0] +
                            worldNormal[1] * item.dir[1] +
                            worldNormal[2] * item.dir[2],
                    );
                    for (let channel = 0; channel < 3; channel += 1) {
                        color[channel] += dot * item.color[channel];
                    }
                }
                for (let channel = 0; channel < 3; channel += 1) {
                    color[channel] = Math.max(0, Math.min(255, color[channel]));
                }
                if (this.geometryMode & 0x40000) {
                    const uv = this.lookAt.map((direction) => {
                        const dot = Math.max(
                            -1,
                            Math.min(
                                1,
                                worldNormal.reduce(
                                    (sum, n, axis) => sum + n * direction[axis],
                                    0,
                                ),
                            ),
                        );
                        return this.geometryMode & 0x80000
                            ? Math.acos(dot) / Math.PI
                            : (dot + 1) / 2;
                    });
                    s = uv[0] * 1024 * this.textureScale[0];
                    t = uv[1] * 1024 * this.textureScale[1];
                }
            }
            this.vertices[first + i] = { clip, color, s, t };
        }
    }

    screen(vertex) {
        const [x, y, z, w] = vertex.clip;
        return {
            x: this.viewport.translate[0] + (x / w) * this.viewport.scale[0],
            y: this.viewport.translate[1] - (y / w) * this.viewport.scale[1],
            z: (z / w + 1) / 2,
            w,
            color: vertex.color,
            s: vertex.s,
            t: vertex.t,
        };
    }

    triangle(indices) {
        let polygon = indices.map((index) => this.vertices[index]);
        if (polygon.some((vertex) => !vertex))
            throw new Error('F3D triangle references unloaded vertex.');
        let anyOutside = 0;
        let allOutside = 63;
        for (const vertex of polygon) {
            const [x, y, z, w] = vertex.clip;
            const code =
                (x < -w ? 1 : 0) |
                (x > w ? 2 : 0) |
                (y < -w ? 4 : 0) |
                (y > w ? 8 : 0) |
                (z < -w ? 16 : 0) |
                (z > w ? 32 : 0);
            anyOutside |= code;
            allOutside &= code;
        }
        if (allOutside !== 0) return;
        if (anyOutside === 0) {
            this.rdp.triangle(
                this.screen(polygon[0]),
                this.screen(polygon[1]),
                this.screen(polygon[2]),
                this.textureEnabled,
                this.textureTile,
                this.geometryMode,
            );
            return;
        }
        const planes = [
            (v) => v[3] + v[0],
            (v) => v[3] - v[0],
            (v) => v[3] + v[1],
            (v) => v[3] - v[1],
            (v) => v[3] + v[2],
            (v) => v[3] - v[2],
        ];
        for (const plane of planes) {
            const input = polygon;
            polygon = [];
            for (let i = 0; i < input.length; i += 1) {
                const a = input[i];
                const b = input[(i + 1) % input.length];
                const da = plane(a.clip);
                const db = plane(b.clip);
                if (da >= 0) polygon.push(a);
                if (da >= 0 !== db >= 0) {
                    const fraction = da / (da - db);
                    const lerp = (av, bv) => av + (bv - av) * fraction;
                    polygon.push({
                        clip: a.clip.map((v, j) => lerp(v, b.clip[j])),
                        color: a.color.map((v, j) => lerp(v, b.color[j])),
                        s: lerp(a.s, b.s),
                        t: lerp(a.t, b.t),
                    });
                }
            }
            if (polygon.length < 3) return;
        }
        const projected = polygon.map((vertex) => this.screen(vertex));
        for (let i = 1; i + 1 < projected.length; i += 1) {
            this.rdp.triangle(
                projected[0],
                projected[i],
                projected[i + 1],
                this.textureEnabled,
                this.textureTile,
                this.geometryMode,
            );
        }
    }

    run(task) {
        this.tasks += 1;
        this.modelview = [identity()];
        this.projection = identity();
        this.updateMatrix();
        let pc = task.data & 0x007fffff;
        const stack = [];
        let remaining = 200000;
        while (remaining-- > 0) {
            const w0 = this.bus.read32(pc);
            const w1 = this.bus.read32(pc + 4);
            const op = w0 >>> 24;
            this.trace.push([pc, w0, w1]);
            if (this.trace.length > 64) this.trace.shift();
            this.commands[op] += 1;
            pc += 8;
            if (op >= 0xc0) {
                if (op === 0xe4 || op === 0xe5) {
                    this.rdp.textureRectangle(
                        w0,
                        w1,
                        this.bus.read32(pc + 4),
                        this.bus.read32(pc + 12),
                        op === 0xe5,
                    );
                    pc += 16;
                } else this.rdp.command(w0, w1, (value) => this.address(value));
                continue;
            }
            switch (op) {
                case 0:
                    break;
                case 1:
                    this.matrix((w0 >>> 16) & 255, this.address(w1));
                    break;
                case 3:
                    this.moveMemory((w0 >>> 16) & 255, this.address(w1));
                    break;
                case 4:
                    this.loadVertices(
                        this.address(w1),
                        (w0 >>> 16) & 15,
                        ((w0 >>> 20) & 15) + 1,
                    );
                    break;
                case 6:
                    if (((w0 >>> 16) & 255) === 0) stack.push(pc);
                    if (stack.length > 32)
                        throw new Error('RSP display-list stack overflow.');
                    pc = this.address(w1);
                    break;
                case 0xb3:
                case 0xb4:
                    break;
                case 0xb6:
                    this.geometryMode &= ~w1;
                    break;
                case 0xb7:
                    this.geometryMode |= w1;
                    break;
                case 0xb8:
                    if (stack.length === 0) return;
                    pc = stack.pop();
                    break;
                case 0xb9:
                case 0xba: {
                    const shift = (w0 >>> 8) & 255;
                    const length = w0 & 255;
                    const mask =
                        (length === 32 ? 0xffffffff : 2 ** length - 1) << shift;
                    const field = op === 0xba ? 'otherH' : 'otherL';
                    this.rdp[field] =
                        ((this.rdp[field] & ~mask) | (w1 & mask)) >>> 0;
                    break;
                }
                case 0xbb:
                    this.textureEnabled = (w0 & 255) !== 0;
                    this.textureTile = (w0 >>> 8) & 7;
                    this.textureScale = [
                        (w1 >>> 16) / 65536,
                        (w1 & 65535) / 65536,
                    ];
                    break;
                case 0xbc:
                    this.moveWord(w0 & 255, (w0 >>> 8) & 65535, w1);
                    break;
                case 0xbd:
                    if (this.modelview.length > 1) this.modelview.pop();
                    this.updateMatrix();
                    break;
                case 0xbe:
                    break; // Per-triangle homogeneous clipping remains authoritative.
                case 0xbf:
                    this.triangle([
                        ((w1 >>> 16) & 255) / 10,
                        ((w1 >>> 8) & 255) / 10,
                        (w1 & 255) / 10,
                    ]);
                    break;
                default:
                    throw new Error(
                        `Unsupported F3D command 0x${op.toString(16)} at 0x${(pc - 8).toString(16)}`,
                    );
            }
        }
        throw new Error('RSP display-list command budget exceeded.');
    }
}

export { RSPGraphics, multiply, transform };
