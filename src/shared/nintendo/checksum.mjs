function checksum32(values) {
    let sum = 0 >>> 0;

    for (const value of values) {
        sum = (sum + (value >>> 0)) >>> 0;
    }

    return sum >>> 0;
}

export {
    checksum32,
};
