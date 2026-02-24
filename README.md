# NES Emulator Kernel (JavaScript)

This project provides a pure JavaScript headless NES emulator kernel.
Current stage focuses on core execution only:

- ROM parsing (`iNES` header)
- Kernel lifecycle (load ROM, run frame loop)
- Controller input API
- Node.js smoke tests with `Mario.nes`

Canvas rendering, browser controls, and audio output integration can be
added as the next layer on top of this kernel.

## Requirements

- Node.js 20+

## Install

```bash
npm install
```

## Run headless kernel with Mario.nes

```bash
npm run smoke
```

Or run manually:

```bash
node src/cli/run-headless.js --rom ./Mario.nes --frames 120
```

## Tests

```bash
npm test
```

## Public API

```js
const { NESKernel } = require('./src');

const kernel = new NESKernel();
kernel.loadROMFromFile('./Mario.nes');
kernel.runFrames(60);
console.log(kernel.getExecutionState());
```
