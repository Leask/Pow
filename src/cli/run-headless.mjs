import fs from 'node:fs';
import path from 'node:path';
import {
    createNintendoKernel,
    createNintendoKernelFromROM,
} from '../core/emulator-factory.mjs';

function parseArgs(argv) {
    const options = {
        rom: './Mario.nes',
        frames: 120,
        strictOpcodes: false,
        system: null,
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

        if (arg === '--system') {
            options.system = argv[index + 1];
            index += 1;
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
    console.log('Usage: node src/cli/run-headless.mjs [options]');
    console.log('');
    console.log('Options:');
    console.log('  --rom <path>         Path to a .nes/.smc/.sfc ROM file');
    console.log('  --system <name>      Force system: nes or snes');
    console.log('  --frames <n>         Number of frames to execute');
    console.log('  --strict-opcodes     Throw on unsupported opcodes (NES)');
    console.log('  --help, -h           Show this help');
}

function buildSummary(romPath, system, metadata, state, requestedFrames) {
    const summary = {
        rom: romPath,
        system,
        format: metadata.format,
        requestedFrames,
        frameCount: state.frameCount,
        audioSampleCount: state.audioSampleCount ?? 0,
        lastFrameChecksum: state.lastFrameChecksum,
        unsupportedOpcodeCount: state.unsupportedOpcodes?.length ?? 0,
        cpu: state.cpu ?? null,
        ppu: state.ppu ?? null,
    };

    if (system === 'nes') {
        summary.mapper = metadata.mapperId;
        summary.mirroring = metadata.mirroring;
        summary.prgRomBanks = metadata.prgRomBanks;
        summary.chrRomBanks = metadata.chrRomBanks;
    }

    if (system === 'snes') {
        summary.layout = metadata.layout;
        summary.mapMode = metadata.mapMode;
        summary.title = metadata.title;
        summary.region = metadata.region;
        summary.hasCopierHeader = metadata.hasCopierHeader;
    }

    return summary;
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
    const romData = fs.readFileSync(romPath);
    const kernelOptions = {
        strictOpcodes: options.strictOpcodes,
    };
    const selected = options.system
        ? {
            system: String(options.system).trim().toLowerCase(),
            kernel: createNintendoKernel(options.system, kernelOptions),
        }
        : createNintendoKernelFromROM(romData, kernelOptions);
    const { kernel, system } = selected;
    const metadata = kernel.loadROMBuffer(romData);
    kernel.runFrames(options.frames);
    const state = kernel.getExecutionState();
    const summary = buildSummary(
        romPath,
        system,
        metadata,
        state,
        options.frames,
    );

    console.log(JSON.stringify(summary, null, 4));
}

try {
    main();
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
