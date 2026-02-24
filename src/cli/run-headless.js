import path from 'node:path';
import { NESKernel } from '../core/nes-kernel.js';

function parseArgs(argv) {
    const options = {
        rom: './Mario.nes',
        frames: 120,
        strictOpcodes: false,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];

        if (arg === '--rom') {
            options.rom = argv[index + 1];
            index += 1;
            continue;
        }

        if (arg === '--frames') {
            options.frames = Number.parseInt(argv[index + 1], 10);
            index += 1;
            continue;
        }

        if (arg === '--strict-opcodes') {
            options.strictOpcodes = true;
            continue;
        }

        if (arg === '--help' || arg === '-h') {
            options.help = true;
            continue;
        }

        throw new Error(`Unknown argument: ${arg}`);
    }

    return options;
}

function printHelp() {
    console.log('Usage: node src/cli/run-headless.js [options]');
    console.log('');
    console.log('Options:');
    console.log('  --rom <path>         Path to a .nes ROM file');
    console.log('  --frames <n>         Number of frames to execute');
    console.log('  --strict-opcodes     Throw on unsupported opcodes');
    console.log('  --help, -h           Show this help');
}

function main() {
    const options = parseArgs(process.argv.slice(2));

    if (options.help) {
        printHelp();
        return;
    }

    if (!Number.isInteger(options.frames) || options.frames <= 0) {
        throw new RangeError('--frames must be a positive integer.');
    }

    const romPath = path.resolve(process.cwd(), options.rom);
    const kernel = new NESKernel({
        strictOpcodes: options.strictOpcodes,
    });
    const metadata = kernel.loadROMFromFile(romPath);
    kernel.runFrames(options.frames);
    const state = kernel.getExecutionState();

    const summary = {
        rom: metadata.path,
        format: metadata.format,
        mapper: metadata.mapperId,
        mirroring: metadata.mirroring,
        prgRomBanks: metadata.prgRomBanks,
        chrRomBanks: metadata.chrRomBanks,
        requestedFrames: options.frames,
        frameCount: state.frameCount,
        lastFrameChecksum: state.lastFrameChecksum,
        unsupportedOpcodeCount: state.unsupportedOpcodes.length,
        cpu: state.cpu,
        ppu: state.ppu,
    };

    console.log(JSON.stringify(summary, null, 4));
}

try {
    main();
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
