// Nintendo handheld palettes use five bits per red, green and blue channel.
function color15(value) {
    const r = value & 31,
        g = (value >>> 5) & 31,
        b = (value >>> 10) & 31;
    return (
        (0xff000000 |
            (((r << 3) | (r >>> 2)) << 16) |
            (((g << 3) | (g >>> 2)) << 8) |
            (b << 3) |
            (b >>> 2)) >>>
        0
    );
}

export { color15 };
