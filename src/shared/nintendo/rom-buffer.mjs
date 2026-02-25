function toByteArray(data, label = 'ROM data') {
    if (data instanceof Uint8Array) {
        return data;
    }

    if (ArrayBuffer.isView(data)) {
        return new Uint8Array(
            data.buffer,
            data.byteOffset,
            data.byteLength,
        );
    }

    if (data instanceof ArrayBuffer) {
        return new Uint8Array(data);
    }

    throw new TypeError(
        `${label} must be Uint8Array, ArrayBuffer, or TypedArray view.`,
    );
}

function readAscii(bytes, start, length) {
    let output = '';

    for (let index = 0; index < length; index += 1) {
        const code = bytes[start + index] ?? 0;

        if (code === 0) {
            break;
        }

        output += String.fromCharCode(code);
    }

    return output;
}

export {
    toByteArray,
    readAscii,
};
