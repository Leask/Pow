import { Apu } from './apu/apu-core.mjs';

const SNES_CPU_CLOCK = 3_579_545;
const SPC_CLOCK = 32_040 * 32;
const SNES_FRAME_RATE = 60.09881389744051;
const DEFAULT_SAMPLE_RATE = 44_100;

const SNAPSHOT_SKIP_KEYS = new Set([
    'snes',
    'apu',
    'mem',
    'functions',
    'modes',
    'cycles',
]);

function clampSample(value) {
    if (value > 1) {
        return 1;
    }

    if (value < -1) {
        return -1;
    }

    return value;
}

function ensureFloatBuffer(buffer, length) {
    if (buffer.length >= length) {
        return buffer;
    }

    const nextLength = Math.max(length, buffer.length * 2);
    return new Float64Array(nextLength);
}

function snapshotValue(value) {
    if (ArrayBuffer.isView(value)) {
        return Array.from(value);
    }

    if (Array.isArray(value)) {
        return value.map((entry) => snapshotValue(entry));
    }

    if (value && typeof value === 'object') {
        return snapshotObject(value);
    }

    return value;
}

function snapshotObject(target) {
    const result = {};
    const keys = Object.keys(target);

    for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index];

        if (SNAPSHOT_SKIP_KEYS.has(key)) {
            continue;
        }

        const value = target[key];

        if (typeof value === 'function') {
            continue;
        }

        result[key] = snapshotValue(value);
    }

    return result;
}

function restoreArray(target, source) {
    target.length = source.length;

    for (let index = 0; index < source.length; index += 1) {
        target[index] = source[index];
    }
}

function restoreObject(target, snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
        return;
    }

    const keys = Object.keys(snapshot);

    for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index];

        if (SNAPSHOT_SKIP_KEYS.has(key)) {
            continue;
        }

        const source = snapshot[key];
        const destination = target[key];

        if (ArrayBuffer.isView(destination) && Array.isArray(source)) {
            destination.set(source);
            continue;
        }

        if (Array.isArray(destination) && Array.isArray(source)) {
            restoreArray(destination, source);
            continue;
        }

        if (
            destination &&
            source &&
            typeof destination === 'object' &&
            typeof source === 'object'
        ) {
            restoreObject(destination, source);
            continue;
        }

        target[key] = source;
    }
}

class SNESSimpleAudio {
    constructor(options = {}) {
        this.sampleRate = Number.isFinite(options.sampleRate) &&
            options.sampleRate >= 8_000
            ? Math.round(options.sampleRate)
            : DEFAULT_SAMPLE_RATE;
        this.onSample = typeof options.onSample === 'function'
            ? options.onSample
            : null;

        this.cpuToSpcRatio = SPC_CLOCK / SNES_CPU_CLOCK;
        this.cpuCycleAccumulator = 0;
        this.outputSampleAccumulator = 0;

        this.apu = new Apu(null);
        this.leftMixBuffer = new Float64Array(2_048);
        this.rightMixBuffer = new Float64Array(2_048);
    }

    clock(cpuCycles) {
        this.cpuCycleAccumulator += cpuCycles * this.cpuToSpcRatio;
        const wholeCycles = Math.floor(this.cpuCycleAccumulator);

        if (wholeCycles <= 0) {
            return;
        }

        this.cpuCycleAccumulator -= wholeCycles;

        for (let index = 0; index < wholeCycles; index += 1) {
            this.apu.cycle();
        }
    }

    handlePortWrite(port, value) {
        this.apu.spcReadPorts[port & 0x03] = value & 0xff;
    }

    readPort(port) {
        return this.apu.spcWritePorts[port & 0x03] & 0xff;
    }

    endFrame(frameCount = 1) {
        for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
            this.#emitFrameSamples();
        }
    }

    saveState() {
        return {
            sampleRate: this.sampleRate,
            cpuToSpcRatio: this.cpuToSpcRatio,
            cpuCycleAccumulator: this.cpuCycleAccumulator,
            outputSampleAccumulator: this.outputSampleAccumulator,
            apu: snapshotObject(this.apu),
        };
    }

    loadState(state) {
        this.sampleRate = Number.isFinite(state.sampleRate) &&
            state.sampleRate >= 8_000
            ? Math.round(state.sampleRate)
            : this.sampleRate;
        this.cpuToSpcRatio = Number.isFinite(state.cpuToSpcRatio)
            ? state.cpuToSpcRatio
            : SPC_CLOCK / SNES_CPU_CLOCK;
        this.cpuCycleAccumulator = Number.isFinite(state.cpuCycleAccumulator)
            ? state.cpuCycleAccumulator
            : 0;
        this.outputSampleAccumulator = Number.isFinite(state.outputSampleAccumulator)
            ? state.outputSampleAccumulator
            : 0;

        restoreObject(this.apu, state.apu ?? {});
    }

    #emitFrameSamples() {
        this.outputSampleAccumulator += this.sampleRate / SNES_FRAME_RATE;
        const outputSampleCount = Math.floor(this.outputSampleAccumulator);
        this.outputSampleAccumulator -= outputSampleCount;

        if (outputSampleCount <= 0) {
            this.apu.dsp.sampleOffset = 0;
            return;
        }

        this.leftMixBuffer = ensureFloatBuffer(this.leftMixBuffer, outputSampleCount);
        this.rightMixBuffer = ensureFloatBuffer(this.rightMixBuffer, outputSampleCount);
        this.apu.setSamples(
            this.leftMixBuffer,
            this.rightMixBuffer,
            outputSampleCount,
        );

        if (!this.onSample) {
            return;
        }

        for (let index = 0; index < outputSampleCount; index += 1) {
            const left = this.leftMixBuffer[index];
            const right = this.rightMixBuffer[index];
            const dominant = Math.abs(left) >= Math.abs(right)
                ? left
                : right;
            this.onSample(clampSample(dominant * 2.4));
        }
    }
}

export {
    SNESSimpleAudio,
};
