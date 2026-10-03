import { checksum32 } from '../../shared/nintendo/checksum.mjs';
import { normalizeN64ROM, parseN64Header } from './rom.mjs';
import { N64Bus } from './bus.mjs';
import { VR4300 } from './cpu-vr4300.mjs';
import { bootN64 } from './boot.mjs';
import { RSPAudio } from './rsp-audio.mjs';
import { RSPGraphics } from './rsp-graphics.mjs';
import { VideoInterface } from './video-interface.mjs';
import { N64_BUTTON_MASKS } from './controller.mjs';
import { snapshot, restore } from './state.mjs';

class N64Kernel {
    constructor(options = {}) {
        this.options = options;
        this.rom = null;
        this.bus = null;
        this.cpu = null;
        this.frameCount = 0;
        this.audioSampleCount = 0;
        this.lastFrameBuffer = null;
        this.lastFrameChecksum = null;
        this.lastStatus = null;
    }

    loadROMBuffer(data) {
        this.header = parseN64Header(data);
        this.rom = normalizeN64ROM(data).bytes;
        this.bus = null;
        this.reset();
        this.lastStatus = 'N64 ROM loaded';
        this.options.onStatusUpdate?.(this.lastStatus);
        return this.getROMMetadata();
    }

    reset() {
        if (!this.rom)
            throw new Error('No ROM loaded. Call loadROMBuffer() first.');
        this.frameCount = 0;
        this.audioSampleCount = 0;
        const eeprom = this.bus?.eeprom.slice();
        this.bus = new N64Bus(this.rom, {
            ...this.options,
            region: this.header.region,
            onAudioSample: (sample, count) => {
                this.audioSampleCount = count;
                this.options.onAudioSample?.(sample, count);
            },
        });
        if (eeprom) this.bus.eeprom.set(eeprom);
        this.cpu = new VR4300(this.bus);
        this.rspAudio = new RSPAudio(this.bus);
        this.graphics = new RSPGraphics(this.bus);
        this.video = new VideoInterface(this.bus);
        this.bus.onTask = (task) => {
            if (task.type === 1) this.graphics.run(task);
            else if (task.type === 2) this.rspAudio.run(task);
            else throw new Error(`Unsupported RSP task type ${task.type}`);
        };
        bootN64(this.cpu, this.bus, this.header);
        this.lastFrameBuffer = this.video.frameBuffer;
        this.lastFrameBuffer.fill(0xff000000);
        this.lastFrameChecksum = checksum32(this.lastFrameBuffer);
    }

    runFrame() {
        this.ensureCore();
        const target = this.bus.frame + 1;
        while (this.bus.frame < target) {
            // A taken self-branch with a NOP delay slot cannot change
            // state. Advance only to the next device/timer boundary, never past it.
            if (
                this.cpu.pc === this.cpu.idleLoopPC &&
                !this.cpu.delaySlot &&
                (this.cpu.cp0[12] & 7) === 1 &&
                !this.bus.interruptPending &&
                !(this.cpu.cp0[13] & 0x8300) &&
                this.cpu.idleBranchTaken() &&
                this.bus.read32(this.cpu.pc & 0x1fffffff) ===
                    this.cpu.idleLoopInstruction &&
                this.bus.read32((this.cpu.pc + 4) & 0x1fffffff) === 0
            ) {
                let cycles = Math.min(4096, this.bus.nextVI - this.bus.cycles);
                for (const event of this.bus.events) {
                    cycles = Math.min(cycles, event.time - this.bus.cycles);
                }
                const timer = (this.cpu.cp0[11] - this.cpu.cp0[9]) >>> 0;
                if (timer !== 0) cycles = Math.min(cycles, timer * 2);
                cycles = Math.floor(cycles / 4) * 4;
                if (cycles >= 4) {
                    this.cpu.advance(cycles);
                    this.bus.clock(cycles);
                    continue;
                }
            }
            this.bus.clock(this.cpu.step());
        }
        this.frameCount = this.bus.frame;
        this.lastFrameBuffer = this.video.render();
        this.lastFrameChecksum = checksum32(this.lastFrameBuffer);
        this.options.onFrame?.(this.lastFrameBuffer, this.frameCount);
        return this.getExecutionState();
    }

    runFrames(count) {
        if (!Number.isInteger(count) || count <= 0) {
            throw new RangeError('frameCount must be a positive integer.');
        }
        for (let i = 0; i < count; i += 1) this.runFrame();
        return this.getExecutionState();
    }

    controller(player) {
        this.ensureCore();
        if (!Number.isInteger(player) || player < 1 || player > 4) {
            throw new RangeError('N64 player must be 1 through 4.');
        }
        return this.bus.controllers[player - 1];
    }

    saveState() {
        this.ensureCore();
        return {
            version: 1,
            system: 'n64',
            cartridge: [this.header.crc1, this.header.crc2, this.rom.length],
            frameCount: this.frameCount,
            audioSampleCount: this.audioSampleCount,
            cpu: snapshot(this.cpu),
            bus: snapshot(this.bus),
            audio: snapshot(this.rspAudio),
            graphics: snapshot(this.graphics),
        };
    }

    loadState(state) {
        this.ensureCore();
        if (
            state.version !== 1 ||
            state.system !== 'n64' ||
            state.cartridge[0] !== this.header.crc1 ||
            state.cartridge[1] !== this.header.crc2 ||
            state.cartridge[2] !== this.rom.length
        ) {
            throw new Error('Incompatible N64 save state.');
        }
        restore(this.cpu, state.cpu);
        restore(this.bus, state.bus);
        restore(this.rspAudio, state.audio);
        restore(this.graphics, state.graphics);
        this.graphics.rdp.texelCache.clear();
        this.frameCount = state.frameCount;
        this.audioSampleCount = state.audioSampleCount;
        this.lastFrameBuffer = this.video.render();
        this.lastFrameChecksum = checksum32(this.lastFrameBuffer);
    }

    pressButton(player, button) {
        this.controller(player).setButton(button, true);
    }
    releaseButton(player, button) {
        this.controller(player).setButton(button, false);
    }
    setAnalogStick(player, x, y) {
        this.controller(player).setStick(x, y);
    }

    getROMMetadata() {
        return this.rom
            ? {
                  ...this.header,
                  screen: { width: 320, height: 240 },
                  frameRate: this.header.region === 'PAL' ? 50 : 60,
                  audioChannels: 2,
                  emulation: 'interpreter-rsp-hle',
              }
            : null;
    }

    getExecutionState() {
        this.ensureCore();
        return {
            system: 'n64',
            frameCount: this.frameCount,
            audioSampleCount: this.audioSampleCount,
            lastFrameChecksum: this.lastFrameChecksum,
            lastStatus: this.lastStatus,
            cpu: {
                pc: this.cpu.pc,
                sp: this.cpu.lo[29],
                status: this.cpu.cp0[12],
                totalCycles: this.cpu.totalCycles,
                instructions: this.cpu.instructions,
                exceptions: this.cpu.exceptionCount,
            },
            ppu: {
                frame: this.bus.frame,
                width: this.video.width,
                height: this.video.height,
            },
            rsp: {
                ...this.bus.taskCounts,
                triangles: this.graphics.rdp.triangles,
            },
            audio: {
                nonzeroSamples: this.bus.audio.nonzeroSamples,
                peak: this.bus.audio.peak,
                completedBuffers: this.bus.audio.completedBuffers,
            },
            unsupportedOpcodes: [],
        };
    }

    ensureCore() {
        if (!this.cpu)
            throw new Error('No ROM loaded. Call loadROMBuffer() first.');
    }
}

export { N64Kernel, N64_BUTTON_MASKS };
