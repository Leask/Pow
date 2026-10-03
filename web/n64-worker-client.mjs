import { parseN64Header } from '../src/core/n64/rom.mjs';

// GUI adapter only. The public core remains synchronous and host-neutral.
class N64WorkerClient {
    constructor(options) {
        this.options = options;
        this.isAsync = true;
        this.epoch = 0;
        this.frameCount = 0;
        this.state = { frameCount: 0 };
        this.worker = new Worker(new URL('./n64-worker.mjs', import.meta.url), {
            type: 'module',
        });
        this.worker.onmessage = ({ data }) => {
            if (data.epoch !== this.epoch) return;
            if (data.type === 'error') options.onError(new Error(data.message));
            else if (data.type === 'frame') {
                this.state = data.state;
                this.frameCount = data.state.frameCount;
                this.lastFrameBuffer = data.pixels;
                options.onAudioBlock(data.audio);
                options.onFrame();
            }
        };
        this.worker.onerror = (error) =>
            options.onError(new Error(error.message || 'N64 worker failed.'));
    }

    send(type, values = {}) {
        this.worker.postMessage({ type, epoch: this.epoch, ...values });
    }

    loadROMBuffer(rom) {
        const header = parseN64Header(rom);
        this.metadata = {
            ...header,
            screen: { width: 320, height: 240 },
            frameRate: header.region === 'PAL' ? 50 : 60,
            audioChannels: 2,
        };
        this.epoch += 1;
        const bytes = new Uint8Array(rom);
        this.worker.postMessage(
            {
                type: 'load',
                epoch: this.epoch,
                rom: bytes,
                sampleRate: this.options.sampleRate,
            },
            [bytes.buffer],
        );
        return this.metadata;
    }

    getROMMetadata() {
        return this.metadata;
    }
    getExecutionState() {
        return this.state;
    }
    runFrame() {
        this.send('step');
    }
    start() {
        this.send('start');
    }
    reportPlayed(played) {
        this.send('played', { played });
    }
    pressButton(player, button) {
        this.send('button', { button, pressed: true });
    }
    releaseButton(player, button) {
        this.send('button', { button, pressed: false });
    }
    setAnalogStick(player, x, y) {
        this.send('stick', { x, y });
    }
    pause() {
        this.epoch += 1;
        this.send('pause');
    }
    reset() {
        this.epoch += 1;
        this.send('reset');
    }
    dispose() {
        this.worker.terminate();
    }
}

export { N64WorkerClient };
