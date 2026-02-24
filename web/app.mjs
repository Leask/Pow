import { NESKernel } from '../src/index.mjs';

const WIDTH = 256;
const HEIGHT = 240;
const AUDIO_SAMPLE_RATE = 44100;
const AUDIO_QUEUE_CAPACITY = 262144;

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
const imageData = context.createImageData(WIDTH, HEIGHT);

let kernel = null;
let running = false;
let fpsCounter = 0;
let fpsClock = performance.now();
let lastRomData = null;
let audioContext = null;
let audioNode = null;
let audioWriteIndex = 0;
let audioReadIndex = 0;
let audioSize = 0;
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
    mapperText.textContent = String(metadata.mapperId);
}

function drawFrame(frame) {
    if (!frame) {
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

function loop() {
    if (running) {
        try {
            runOneFrame();
        } catch (error) {
            running = false;
            updateButtons();
            setError(error.message);
        }
    }

    requestAnimationFrame(loop);
}

function createKernel(romData, fileName) {
    clearAudioQueue();
    kernel = new NESKernel({
        sampleRate: AUDIO_SAMPLE_RATE,
        onAudioSample: (sample) => {
            pushAudioSample(sample);
        },
    });
    const metadata = kernel.loadROMBuffer(romData);

    romName.textContent = fileName;
    mapperText.textContent = String(metadata.mapperId);
    fpsText.textContent = '0';
    fpsCounter = 0;
    fpsClock = performance.now();

    runOneFrame();
    updateButtons();
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
        createKernel(lastRomData, file.name);
    } catch (error) {
        setError(error.message);
    }
});

startBtn.addEventListener('click', () => {
    if (!kernel) {
        return;
    }

    try {
        const contextForPlayback = ensureAudioContext();
        void contextForPlayback.resume();
    } catch (error) {
        setError(error.message);
    }

    running = true;
    setError('');
    updateButtons();
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
        createKernel(lastRomData, romName.textContent);
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
    if (!kernel) {
        return;
    }

    const button = keyMap.get(event.key) || keyMap.get(event.key.toLowerCase());

    if (!button) {
        return;
    }

    event.preventDefault();
    kernel.pressButton(1, button);
});

window.addEventListener('keyup', (event) => {
    if (!kernel) {
        return;
    }

    const button = keyMap.get(event.key) || keyMap.get(event.key.toLowerCase());

    if (!button) {
        return;
    }

    event.preventDefault();
    kernel.releaseButton(1, button);
});

context.fillStyle = '#000000';
context.fillRect(0, 0, WIDTH, HEIGHT);
updateButtons();
loop();
