import { createNintendoKernelFromROM } from '../src/index.mjs';

const DEFAULT_WIDTH = 256;
const DEFAULT_HEIGHT = 240;
const AUDIO_SAMPLE_RATE = 44_100;
const AUDIO_QUEUE_CAPACITY = 262144;
const AUDIO_WARMUP_MS = 120;
const AUDIO_LOW_WATER_MS = 50;
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
}

function pushAudioSample(sample) {
    if (audioSize >= AUDIO_QUEUE_CAPACITY) {
        return;
    }

    audioQueue[audioWriteIndex] = sample;
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

function ensureAudioContext() {
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
    audioNode = audioContext.createScriptProcessor(1024, 0, 1);
    audioNode.onaudioprocess = (event) => {
        const output = event.outputBuffer.getChannelData(0);

        for (let index = 0; index < output.length; index += 1) {
            output[index] = pullAudioSample();
        }
    };
    audioNode.connect(audioContext.destination);
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
    drawFrame(kernel.lastFrameBuffer);
    updateStatus();

    fpsCounter += 1;
    const now = performance.now();

    if (now - fpsClock >= 1000) {
        fpsText.textContent = String(fpsCounter);
        fpsCounter = 0;
        fpsClock = now;
    }
}

function topOffAudioQueue(targetSize) {
    if (!kernel || !audioContext || audioContext.state !== 'running') {
        return 0;
    }

    let framesAdvanced = 0;

    while (
        audioSize < targetSize &&
        framesAdvanced < AUDIO_CATCHUP_MAX_FRAMES
    ) {
        kernel.runFrame();
        framesAdvanced += 1;
    }

    return framesAdvanced;
}

function loop() {
    if (running) {
        try {
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
    hasStartedPlayback = false;
    clearAudioQueue();

    const selected = createNintendoKernelFromROM(romData, {
        sampleRate: normalizedSampleRate,
        onAudioSample: (sample) => {
            pushAudioSample(sample);
        },
    });

    kernel = selected.kernel;
    currentSystem = selected.system;
    const metadata = kernel.loadROMBuffer(romData);
    const screen = metadata.screen ?? {
        width: DEFAULT_WIDTH,
        height: currentSystem === 'snes' ? 224 : 240,
    };

    ensureImageBuffer(screen.width, screen.height);

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

    const button = keyMap.get(event.key) || keyMap.get(event.key.toLowerCase());

    if (!button) {
        return;
    }

    event.preventDefault();

    try {
        if (pressed) {
            kernel.pressButton(1, button);
        } else {
            kernel.releaseButton(1, button);
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
        updateButtons();

        const arrayBuffer = await file.arrayBuffer();
        lastRomData = new Uint8Array(arrayBuffer);
        lastRomName = file.name;
        createKernel(lastRomData, file.name);
    } catch (error) {
        setError(error.message);
    }
});

startBtn.addEventListener('click', async () => {
    if (!kernel) {
        return;
    }

    try {
        const contextForPlayback = ensureAudioContext();
        await contextForPlayback.resume();

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
        setError('');
        updateButtons();
    } catch (error) {
        setError(error.message);
    }
});

pauseBtn.addEventListener('click', () => {
    running = false;
    updateButtons();
});

resetBtn.addEventListener('click', () => {
    if (!kernel || !lastRomData) {
        return;
    }

    try {
        running = false;
        createKernel(lastRomData, lastRomName);
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

context.fillStyle = '#000000';
context.fillRect(0, 0, frameWidth, frameHeight);
updateButtons();
loop();
