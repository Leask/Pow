import { createNintendoKernelFromROM } from '../src/index.mjs';
import { ButtonLatch } from './button-latch.mjs';
import { NintendoWorkerClient } from './n64-worker-client.mjs';

const DEFAULT_WIDTH = 256;
const DEFAULT_HEIGHT = 240;
const AUDIO_SAMPLE_RATE = 44_100;
const AUDIO_QUEUE_CAPACITY = 262144;
const AUDIO_WARMUP_MS = 180;
const AUDIO_LOW_WATER_MS = 120;
const AUDIO_CATCHUP_MAX_FRAMES = 8;

const romInput = document.querySelector('#romInput');
const startBtn = document.querySelector('#startBtn');
const pauseBtn = document.querySelector('#pauseBtn');
const resetBtn = document.querySelector('#resetBtn');
const stepBtn = document.querySelector('#stepBtn');
const romName = document.querySelector('#romName');
const frameCount = document.querySelector('#frameCount');
const fpsText = document.querySelector('#fps');
const mapperText = document.querySelector('#mapper');
const errorText = document.querySelector('#errorText');
const audioStatus = document.querySelector('#audioStatus');
const canvas = document.querySelector('#screen');
const context = canvas.getContext('2d', { alpha: false });

let frameWidth = DEFAULT_WIDTH;
let frameHeight = DEFAULT_HEIGHT;
let imageData = context.createImageData(frameWidth, frameHeight);

let kernel = null;
let running = false;
let currentSystem = null;
let fpsCounter = 0;
let fpsClock = performance.now();
let lastRomData = null;
let lastRomName = '';
let audioContext = null;
let audioNode = null;
let audioWriteIndex = 0;
let audioReadIndex = 0;
let audioSize = 0;
let kernelSampleRate = AUDIO_SAMPLE_RATE;
let hasStartedPlayback = false;
const audioQueue = new Float32Array(AUDIO_QUEUE_CAPACITY);
const audioQueueRight = new Float32Array(AUDIO_QUEUE_CAPACITY);
const stickKeys = new Set();
let audioWorklet = false;
let audioSubmitted = 0;
let audioPlayed = 0;
let audioEpoch = 0;
const buttonLatch = new ButtonLatch(
    (button) => kernel.pressButton(1, button),
    (button) => kernel.releaseButton(1, button),
);

const keyMap = new Map([
    ['ArrowUp', 'UP'],
    ['ArrowDown', 'DOWN'],
    ['ArrowLeft', 'LEFT'],
    ['ArrowRight', 'RIGHT'],
    ['w', 'UP'],
    ['s', 'DOWN'],
    ['a', 'LEFT'],
    ['d', 'RIGHT'],
    ['j', 'A'],
    ['k', 'B'],
    ['u', 'X'],
    ['i', 'Y'],
    ['q', 'L'],
    ['e', 'R'],
    ['Enter', 'START'],
    ['Shift', 'SELECT'],
]);

function setError(message = '') {
    errorText.textContent = message;
}

function clearAudioQueue() {
    audioWriteIndex = 0;
    audioReadIndex = 0;
    audioSize = 0;
    audioSubmitted = 0;
    audioPlayed = 0;
    audioEpoch += 1;
    if (audioWorklet) audioNode.port.postMessage({ type: 'clear', epoch: audioEpoch });
}

function queuedAudioFrames() {
    return audioSize + (audioWorklet ? Math.max(0, audioSubmitted - audioPlayed) : 0);
}

function flushAudioQueue() {
    if (!audioWorklet || audioSize === 0) return;
    const samples = new Float32Array(audioSize * 2);
    const count = audioSize;
    for (let i = 0; i < count; i += 1) {
        samples[i * 2] = audioQueue[audioReadIndex];
        samples[i * 2 + 1] = audioQueueRight[audioReadIndex];
        audioReadIndex = (audioReadIndex + 1) % AUDIO_QUEUE_CAPACITY;
    }
    audioSize = 0;
    audioSubmitted += count;
    audioNode.port.postMessage({ type: 'samples', epoch: audioEpoch, samples },
        [samples.buffer]);
}

function pushAudioSample(sample, right = sample) {
    if (audioSize >= AUDIO_QUEUE_CAPACITY) {
        return;
    }

    audioQueue[audioWriteIndex] = sample;
    audioQueueRight[audioWriteIndex] = right;
    audioWriteIndex = (audioWriteIndex + 1) % AUDIO_QUEUE_CAPACITY;
    audioSize += 1;
}

function pullAudioSample() {
    if (audioSize === 0) {
        return 0;
    }

    const sample = audioQueue[audioReadIndex];
    audioReadIndex = (audioReadIndex + 1) % AUDIO_QUEUE_CAPACITY;
    audioSize -= 1;
    return sample;
}

async function ensureAudioContext() {
    if (audioContext) {
        return audioContext;
    }

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;

    if (!AudioContextCtor) {
        throw new Error('WebAudio is not supported in this browser.');
    }

    audioContext = new AudioContextCtor({
        sampleRate: AUDIO_SAMPLE_RATE,
    });
    if (audioContext.audioWorklet) {
        await audioContext.audioWorklet.addModule('/web/audio-worklet.mjs');
        audioNode = new AudioWorkletNode(audioContext, 'pow-audio-output', {
            numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
        });
        audioWorklet = true;
        audioNode.port.onmessage = ({ data }) => {
            if (data.epoch !== audioEpoch) return;
            audioPlayed = data.played;
            kernel?.reportPlayed?.(audioPlayed);
            audioStatus.textContent = !running ? 'Paused'
                : data.started ? 'Stereo' : 'Buffering';
            audioStatus.dataset.played = String(data.played);
            audioStatus.dataset.nonzero = String(data.nonzero);
            audioStatus.dataset.peak = String(data.peak);
            audioStatus.dataset.underruns = String(data.underruns);
        };
        audioNode.port.postMessage({ type: 'clear', epoch: audioEpoch });
        audioNode.connect(audioContext.destination);
        return audioContext;
    }
    audioNode = audioContext.createScriptProcessor(1024, 0, 2);
    audioNode.onaudioprocess = (event) => {
        const output = event.outputBuffer.getChannelData(0);
        const right = event.outputBuffer.getChannelData(1);

        for (let index = 0; index < output.length; index += 1) {
            if (kernel?.isAsync && audioSize > 0) audioPlayed += 1;
            right[index] = audioSize > 0 ? audioQueueRight[audioReadIndex] : 0;
            output[index] = pullAudioSample();
        }
        kernel?.reportPlayed?.(audioPlayed);
    };
    audioNode.connect(audioContext.destination);
    audioStatus.textContent = 'Stereo (legacy output)';
    return audioContext;
}

function getAudioSampleRate() {
    if (audioContext) {
        return Math.round(audioContext.sampleRate);
    }

    return kernelSampleRate;
}

function getAudioQueueTargetSize(milliseconds) {
    const samples = Math.round((getAudioSampleRate() * milliseconds) / 1000);
    const safeSamples = Number.isFinite(samples) && samples > 0
        ? samples
        : 2048;
    return Math.min(
        AUDIO_QUEUE_CAPACITY - 1024,
        Math.max(2048, safeSamples),
    );
}

function ensureImageBuffer(width, height) {
    const safeWidth = Number.isInteger(width) && width > 0
        ? width
        : DEFAULT_WIDTH;
    const safeHeight = Number.isInteger(height) && height > 0
        ? height
        : DEFAULT_HEIGHT;

    if (safeWidth === frameWidth && safeHeight === frameHeight) {
        return;
    }

    frameWidth = safeWidth;
    frameHeight = safeHeight;
    canvas.width = frameWidth;
    canvas.height = frameHeight;
    imageData = context.createImageData(frameWidth, frameHeight);
}

function formatMapper(metadata) {
    if (!metadata) {
        return '-';
    }

    if (currentSystem === 'nes') {
        return String(metadata.mapperId);
    }

    if (currentSystem === 'snes') {
        const mapMode = Number(metadata.mapMode ?? 0)
            .toString(16)
            .padStart(2, '0');
        return `${metadata.layout} / 0x${mapMode}`;
    }

    if (currentSystem === 'n64') {
        return `${metadata.region} / VR4300`;
    }
    if (currentSystem === 'gb' || currentSystem === 'gbc')
        return `MBC${metadata.mapperId ?? 0} / SM83`;
    if (currentSystem === 'gba') return `${metadata.gameCode} / ARM7TDMI`;
    if (currentSystem === 'nds') return `${metadata.gameCode} / ARM9 + ARM7`;

    return '-';
}

function updateButtons() {
    const loaded = kernel !== null;

    startBtn.disabled = !loaded || running;
    pauseBtn.disabled = !loaded || !running;
    resetBtn.disabled = !loaded;
    stepBtn.disabled = !loaded || running;
}

function updateStatus() {
    if (!kernel) {
        frameCount.textContent = '0';
        mapperText.textContent = '-';
        return;
    }

    const state = kernel.getExecutionState();
    const metadata = kernel.getROMMetadata();

    frameCount.textContent = String(state.frameCount);
    mapperText.textContent = formatMapper(metadata);
}

function drawFrame(frame) {
    if (!frame || frame.length !== frameWidth * frameHeight) {
        return;
    }

    const out = imageData.data;

    for (let index = 0; index < frame.length; index += 1) {
        const color = frame[index] >>> 0;
        const offset = index * 4;

        out[offset + 0] = (color >>> 16) & 0xff;
        out[offset + 1] = (color >>> 8) & 0xff;
        out[offset + 2] = color & 0xff;
        out[offset + 3] = (color >>> 24) & 0xff;
    }

    context.putImageData(imageData, 0, 0);
}

function runOneFrame() {
    if (!kernel) {
        return;
    }

    kernel.runFrame();
    if (kernel.isAsync) return;
    buttonLatch.advance(kernel.frameCount);
    flushAudioQueue();
    drawFrame(kernel.lastFrameBuffer);
    updateStatus();

    recordFrame();
}

function recordFrame() {
    fpsCounter += 1;
    const now = performance.now();

    if (now - fpsClock >= 1000) {
        fpsText.textContent = String(fpsCounter);
        fpsCounter = 0;
        fpsClock = now;
    }
}

function topOffAudioQueue(targetSize) {
    if (kernel?.isAsync) return 0;
    if (!kernel || !audioContext || audioContext.state !== 'running') {
        return 0;
    }

    let framesAdvanced = 0;

    while (
        queuedAudioFrames() < targetSize &&
        framesAdvanced < AUDIO_CATCHUP_MAX_FRAMES
    ) {
        kernel.runFrame();
        buttonLatch.advance(kernel.frameCount);
        flushAudioQueue();
        framesAdvanced += 1;
        fpsCounter += 1;
    }

    return framesAdvanced;
}

function loop() {
    if (running && !kernel?.isAsync) {
        try {
            if (audioWorklet && queuedAudioFrames() >=
                getAudioQueueTargetSize(AUDIO_WARMUP_MS)) {
                requestAnimationFrame(loop);
                return;
            }
            runOneFrame();
            const catchupFrames = topOffAudioQueue(
                getAudioQueueTargetSize(AUDIO_LOW_WATER_MS),
            );

            if (catchupFrames > 0) {
                drawFrame(kernel.lastFrameBuffer);
                updateStatus();
            }
        } catch (error) {
            running = false;
            updateButtons();
            setError(error.message);
        }
    }

    requestAnimationFrame(loop);
}

function createKernel(romData, fileName, sampleRate = getAudioSampleRate()) {
    const normalizedSampleRate = Number.isFinite(sampleRate) &&
        sampleRate >= 8_000
        ? Math.round(sampleRate)
        : AUDIO_SAMPLE_RATE;

    kernelSampleRate = normalizedSampleRate;
    buttonLatch.clear();
    kernel?.dispose?.();
    stickKeys.clear();
    hasStartedPlayback = false;
    clearAudioQueue();

    const selected = createNintendoKernelFromROM(romData, {
        sampleRate: normalizedSampleRate,
        onAudioSample: (sample) => {
            if (!['n64', 'gb', 'gbc', 'gba', 'nds'].includes(currentSystem))
                pushAudioSample(sample);
        },
        onAudioFrame: (left, right) => pushAudioSample(left, right),
    });

    currentSystem = selected.system;
    if (['n64', 'gb', 'gbc', 'gba', 'nds'].includes(currentSystem)) {
        const client = new NintendoWorkerClient({
            system: currentSystem,
            sampleRate: normalizedSampleRate,
            onAudioBlock: (audio) => {
                if (kernel !== client) return;
                for (let i = 0; i < audio.length; i += 2) {
                    pushAudioSample(audio[i], audio[i + 1]);
                }
                flushAudioQueue();
            },
            onFrame: () => {
                if (kernel !== client) return;
                drawFrame(client.lastFrameBuffer);
                updateStatus();
                recordFrame();
            },
            onError: (error) => {
                if (kernel !== client) return;
                running = false;
                if (audioWorklet) audioNode.port.postMessage({
                    type: 'active', value: false,
                });
                clearAudioQueue();
                updateButtons();
                setError(error.message);
            },
        });
        kernel = client;
    } else {
        kernel = selected.kernel;
    }
    const metadata = kernel.loadROMBuffer(romData);
    const screen = metadata.screen ?? {
        width: DEFAULT_WIDTH,
        height: currentSystem === 'snes' ? 224 : 240,
    };

    ensureImageBuffer(screen.width, screen.height);
    canvas.classList.toggle('dual-screen', currentSystem === 'nds');

    romName.textContent = `${fileName} (${currentSystem.toUpperCase()})`;
    mapperText.textContent = formatMapper(metadata);
    fpsText.textContent = '0';
    fpsCounter = 0;
    fpsClock = performance.now();

    runOneFrame();
    updateButtons();
}

function handleButtonEvent(event, pressed) {
    if (!kernel) {
        return;
    }

    const key = event.key.toLowerCase();
    if (currentSystem === 'n64' &&
        ['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd']
            .includes(key)) {
        event.preventDefault();
        if (pressed) stickKeys.add(key);
        else stickKeys.delete(key);
        const down = (...keys) => keys.some((name) => stickKeys.has(name));
        let x = (Number(down('d', 'arrowright')) -
            Number(down('a', 'arrowleft'))) * 80;
        let y = (Number(down('w', 'arrowup')) -
            Number(down('s', 'arrowdown'))) * 80;
        if (x !== 0 && y !== 0) { x *= 0.7071; y *= 0.7071; }
        kernel.setAnalogStick(1, x, y);
        return;
    }
    const n64Keys = {
        shift: 'Z', u: 'C_LEFT', i: 'C_UP', o: 'C_RIGHT', p: 'C_DOWN',
    };
    const button = (currentSystem === 'n64' ? n64Keys[key] : null) ||
        keyMap.get(event.key) || keyMap.get(key);

    if (!button) {
        return;
    }

    if (
        ['gb', 'gbc', 'nes'].includes(currentSystem) &&
        ['X', 'Y', 'L', 'R'].includes(button)
    )
        return;
    if (currentSystem === 'gba' && ['X', 'Y'].includes(button)) return;

    event.preventDefault();

    try {
        if (kernel.isAsync) {
            if (pressed) kernel.pressButton(1, button);
            else kernel.releaseButton(1, button);
        } else {
            buttonLatch.update(button, pressed, kernel.frameCount,
                currentSystem === 'n64' ? 3 : 1);
        }
    } catch (error) {
        if (!(error instanceof RangeError)) {
            setError(error.message);
        }
    }
}

romInput.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];

    if (!file) {
        return;
    }

    try {
        setError('');
        running = false;
        if (audioWorklet) audioNode.port.postMessage({ type: 'active', value: false });
        updateButtons();

        const arrayBuffer = await file.arrayBuffer();
        lastRomData = new Uint8Array(arrayBuffer);
        lastRomName = file.name;
        createKernel(lastRomData, file.name);
    } catch (error) {
        setError(error.message);
    }
});

function handleTouch(event, down) {
    if (!kernel || currentSystem !== 'nds') return;
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 256;
    const y = ((event.clientY - rect.top) / rect.height) * 384 - 192;
    if (down && (y < 0 || y >= 192)) return;
    event.preventDefault();
    if (event.type === 'pointerdown') canvas.setPointerCapture(event.pointerId);
    kernel.setTouch(x, y, down);
}
canvas.addEventListener('pointerdown', (event) => handleTouch(event, true));
canvas.addEventListener('pointermove', (event) => {
    if (event.buttons) handleTouch(event, true);
});
canvas.addEventListener('pointerup', (event) => handleTouch(event, false));
canvas.addEventListener('pointercancel', (event) => handleTouch(event, false));

startBtn.addEventListener('click', async () => {
    if (!kernel) {
        return;
    }

    try {
        const contextForPlayback = await ensureAudioContext();
        await contextForPlayback.resume();
        if (audioWorklet) audioNode.port.postMessage({ type: 'active', value: true });

        if (!hasStartedPlayback && lastRomData) {
            const outputSampleRate = Math.round(
                contextForPlayback.sampleRate,
            );

            if (Math.abs(kernelSampleRate - outputSampleRate) > 1) {
                createKernel(lastRomData, lastRomName, outputSampleRate);
            }

            const warmupFrames = topOffAudioQueue(
                getAudioQueueTargetSize(AUDIO_WARMUP_MS),
            );

            if (warmupFrames > 0) {
                drawFrame(kernel.lastFrameBuffer);
                updateStatus();
            }
        }

        hasStartedPlayback = true;
        running = true;
        kernel.start?.();
        setError('');
        updateButtons();
        canvas.focus({ preventScroll: true });
    } catch (error) {
        setError(error.message);
    }
});

pauseBtn.addEventListener('click', () => {
    running = false;
    kernel?.pause?.();
    if (audioWorklet) audioNode.port.postMessage({ type: 'active', value: false });
    clearAudioQueue();
    updateButtons();
});

resetBtn.addEventListener('click', () => {
    if (!kernel || !lastRomData) {
        return;
    }

    try {
        running = false;
        if (audioWorklet) audioNode.port.postMessage({ type: 'active', value: false });
        if (currentSystem === 'n64') {
            // Reset the machine, not the cartridge's persistent EEPROM.
            kernel.reset();
            buttonLatch.clear();
            stickKeys.clear();
            clearAudioQueue();
            hasStartedPlayback = false;
            fpsCounter = 0;
            fpsClock = performance.now();
            runOneFrame();
            updateButtons();
        } else {
            createKernel(lastRomData, lastRomName);
        }
        setError('');
    } catch (error) {
        setError(error.message);
    }
});

stepBtn.addEventListener('click', () => {
    try {
        runOneFrame();
        setError('');
    } catch (error) {
        setError(error.message);
    }
});

window.addEventListener('keydown', (event) => {
    handleButtonEvent(event, true);
});

window.addEventListener('keyup', (event) => {
    handleButtonEvent(event, false);
});

window.addEventListener('blur', () => {
    buttonLatch.clear();
    stickKeys.clear();
    if (currentSystem === 'n64' && kernel) kernel.setAnalogStick(1, 0, 0);
    const buttons = new Set([...keyMap.values(), 'Z',
        'C_LEFT', 'C_RIGHT', 'C_UP', 'C_DOWN']);
    for (const button of buttons) {
        if (
            ['gb', 'gbc', 'nes'].includes(currentSystem) &&
            [
                'X',
                'Y',
                'L',
                'R',
                'Z',
                'C_LEFT',
                'C_RIGHT',
                'C_UP',
                'C_DOWN',
            ].includes(button)
        )
            continue;
        if (
            currentSystem === 'gba' &&
            ['X', 'Y', 'Z', 'C_LEFT', 'C_RIGHT', 'C_UP', 'C_DOWN'].includes(
                button,
            )
        )
            continue;
        if (
            currentSystem !== 'n64' &&
            ['Z', 'C_LEFT', 'C_RIGHT', 'C_UP', 'C_DOWN'].includes(button)
        )
            continue;
        try {
            kernel?.releaseButton(1, button);
        } catch (error) {
            if (!(error instanceof RangeError)) setError(error.message);
        }
    }
    if (currentSystem === 'nds' && kernel) kernel.setTouch(0, 0, false);
});

context.fillStyle = '#000000';
context.fillRect(0, 0, frameWidth, frameHeight);
updateButtons();
loop();
