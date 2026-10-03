function signed16(value) {
    return (value << 16) >> 16;
}
function saturate(value) {
    return Math.max(-32768, Math.min(32767, value));
}
function align(value, size) {
    return Math.ceil(value / size) * size;
}

// ABI1 task interpreter. Samples, books and FIR coefficients come from RDRAM.
class RSPAudio {
    constructor(bus) {
        this.bus = bus;
        this.memory = new Uint8Array(4096);
        this.view = new DataView(this.memory.buffer);
        this.segments = new Uint32Array(16);
        this.book = new Int16Array(256);
        this.coefficients = new Int16Array(256);
        this.input = 0;
        this.output = 0;
        this.count = 0;
        this.aux = [0, 0, 0];
        this.volume = [0, 0];
        this.target = [0, 0];
        this.rate = [65536, 65536];
        this.dry = 32767;
        this.wet = 0;
        this.loop = 0;
        this.envelopes = new Map();
        this.commands = new Uint32Array(16);
    }

    address(value) {
        return (
            (this.segments[(value >>> 24) & 15] + (value & 0x00ffffff)) &
            0x007fffff
        );
    }

    sample(address) {
        return this.view.getInt16(address & 0xffe);
    }
    put(address, value) {
        this.view.setInt16(address & 0xffe, saturate(value));
    }

    run(task) {
        const data = task.ucodeData & 0x007fffff;
        if (
            task.ucodeDataSize < 0x2c0 ||
            this.bus.read32(data) !== 1 ||
            this.bus.read32(data + 4) !== 0x0002ffff
        ) {
            throw new Error('Unsupported RSP audio microcode; expected ABI1.');
        }
        for (let i = 0; i < 256; i += 1) {
            this.coefficients[i] = this.bus.read16(data + 0xc0 + i * 2);
        }
        const start = task.data & 0x007fffff;
        for (let p = start; p < start + task.dataSize; p += 8) {
            const w0 = this.bus.read32(p);
            const w1 = this.bus.read32(p + 4);
            const op = w0 >>> 24;
            const flags = (w0 >>> 16) & 255;
            const low = w0 & 65535;
            const high = w1 >>> 16;
            const tail = w1 & 65535;
            if (op >= 16) throw new Error(`Unsupported ABI1 command ${op}`);
            this.commands[op] += 1;
            switch (op) {
                case 0:
                    break;
                case 1:
                    this.adpcm(flags, this.address(w1));
                    break;
                case 2:
                    this.memory.fill(0, low, low + align(tail, 16));
                    break;
                case 3:
                    this.envelope(flags, this.address(w1));
                    break;
                case 4:
                case 6: {
                    const a = this.address(w1) & ~7;
                    const count = align(this.count, 8);
                    const buffer = op === 4 ? this.input : this.output;
                    for (let i = 0; i < count; i += 1) {
                        if (op === 4)
                            this.memory[(buffer + i) & 4095] = this.bus.read8(
                                a + i,
                            );
                        else
                            this.bus.write8(
                                a + i,
                                this.memory[(buffer + i) & 4095],
                            );
                    }
                    break;
                }
                case 5:
                    this.resample(flags, low, this.address(w1));
                    break;
                case 7:
                    this.segments[(w1 >>> 24) & 15] = w1 & 0x00ffffff;
                    break;
                case 8:
                    if (flags & 8) this.aux = [low, high, tail];
                    else {
                        this.input = low;
                        this.output = high;
                        this.count = tail;
                    }
                    break;
                case 9:
                    if (flags & 8) {
                        this.dry = signed16(low);
                        this.wet = signed16(tail);
                    } else if (flags & 4)
                        this.volume[flags & 2 ? 0 : 1] = signed16(low);
                    else {
                        const channel = flags & 2 ? 0 : 1;
                        this.target[channel] = signed16(low);
                        this.rate[channel] = w1 | 0;
                    }
                    break;
                case 10:
                    for (let i = 0; i < align(tail, 16); i += 16) {
                        const block = this.memory.slice(low + i, low + i + 16);
                        this.memory.set(block, high + i);
                    }
                    break;
                case 11:
                    for (let i = 0; i < low / 2; i += 1) {
                        this.book[i] = this.bus.read16(
                            this.address(w1) + i * 2,
                        );
                    }
                    break;
                case 12:
                    for (let i = 0; i < align(this.count, 32); i += 2) {
                        this.put(
                            tail + i,
                            this.sample(tail + i) +
                                Math.floor(
                                    (this.sample(high + i) * signed16(low)) /
                                        32768,
                                ),
                        );
                    }
                    break;
                case 13:
                    for (let i = 0; i < align(this.count, 16) / 2; i += 1) {
                        this.put(
                            this.output + i * 4,
                            this.sample(high + i * 2),
                        );
                        this.put(
                            this.output + i * 4 + 2,
                            this.sample(tail + i * 2),
                        );
                    }
                    break;
                case 14:
                    throw new Error('ABI1 pole filter is not implemented yet.');
                case 15:
                    this.loop = this.address(w1);
                    break;
            }
        }
    }

    adpcm(flags, stateAddress) {
        let input = this.input;
        let output = this.output;
        const state = flags & 2 ? this.loop : stateAddress;
        for (let i = 0; i < 16; i += 1) {
            this.put(
                output + i * 2,
                flags & 1 ? 0 : signed16(this.bus.read16(state + i * 2)),
            );
        }
        let last2 = this.sample(output + 28);
        let last1 = this.sample(output + 30);
        output += 32;
        const residual = new Int16Array(16);
        for (let count = 0; count < align(this.count, 32); count += 32) {
            const header = this.memory[input++];
            const scale = Math.min(header >>> 4, 12);
            const predictor = (header & 15) * 16;
            for (let i = 0; i < 16; i += 2) {
                const byte = this.memory[input++];
                residual[i] = ((byte << 24) >> 28) * 2 ** scale;
                residual[i + 1] = ((byte << 28) >> 28) * 2 ** scale;
            }
            for (let half = 0; half < 16; half += 8) {
                for (let j = 0; j < 8; j += 1) {
                    let accumulator =
                        residual[half + j] * 2048 +
                        this.book[predictor + j] * last2 +
                        this.book[predictor + 8 + j] * last1;
                    for (let k = 0; k < j; k += 1) {
                        accumulator +=
                            this.book[predictor + 8 + j - k - 1] *
                            residual[half + k];
                    }
                    this.put(output + j * 2, Math.floor(accumulator / 2048));
                }
                last2 = this.sample(output + 12);
                last1 = this.sample(output + 14);
                output += 16;
            }
        }
        for (let i = 0; i < 16; i += 1) {
            this.bus.write16(
                stateAddress + i * 2,
                this.sample(output - 32 + i * 2),
            );
        }
    }

    resample(flags, pitch, state) {
        let source = this.input - 8;
        let fraction = flags & 1 ? 0 : this.bus.read16(state + 8);
        for (let i = 0; i < 4; i += 1) {
            this.put(
                source + i * 2,
                flags & 1 ? 0 : signed16(this.bus.read16(state + i * 2)),
            );
        }
        for (let i = 0; i < align(this.count, 16); i += 2) {
            const index = (fraction >>> 10) * 4;
            let value = 0;
            for (let j = 0; j < 4; j += 1) {
                value +=
                    this.sample(source + j * 2) * this.coefficients[index + j];
            }
            this.put(this.output + i, Math.floor(value / 32768));
            fraction += pitch * 2;
            source += (fraction >>> 16) * 2;
            fraction &= 65535;
        }
        for (let i = 0; i < 4; i += 1) {
            this.bus.write16(state + i * 2, this.sample(source + i * 2));
        }
        this.bus.write16(state + 8, fraction);
    }

    envelope(flags, address) {
        let state = this.envelopes.get(address);
        if (flags & 1 || !state) {
            state = {
                volume: this.volume.slice(),
                target: this.target.slice(),
                rate: this.rate.slice(),
                dry: this.dry,
                wet: this.wet,
            };
        }
        const outputs = [this.output, this.aux[0], this.aux[1], this.aux[2]];
        for (let block = 0; block < align(this.count, 16); block += 16) {
            const next = state.volume.map((volume, channel) => {
                const rate = state.rate[channel] / 65536;
                const target = state.target[channel];
                return rate >= 1
                    ? Math.min(target, volume * rate)
                    : Math.max(target, volume * rate);
            });
            for (let i = 0; i < 8; i += 1) {
                const input = this.sample(this.input + block + i * 2);
                for (
                    let channel = 0;
                    channel < (flags & 8 ? 4 : 2);
                    channel += 1
                ) {
                    const side = channel & 1;
                    const volume =
                        state.volume[side] +
                        ((next[side] - state.volume[side]) * (i + 1)) / 8;
                    const send = channel < 2 ? state.dry : state.wet;
                    const gain = Math.floor((volume * send + 16384) / 32768);
                    const sample = Math.floor((input * gain + 16384) / 32768);
                    const destination = outputs[channel] + block + i * 2;
                    this.put(destination, this.sample(destination) + sample);
                }
            }
            state.volume = next;
        }
        this.envelopes.set(address, state);
    }
}

export { RSPAudio };
