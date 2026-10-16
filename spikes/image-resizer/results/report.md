# Image resizer spike: results

Run 2026-10-16T06:56:21.499Z on linux/x64, Node v22.22.0, 2 CPU(s) (Intel(R) Xeon(R) Processor @ 2.10GHz), 8030 MB RAM. This is **not** the GoDaddy host: timings and memory here are a reference, and the same run must be repeated there.

Libraries: wasm-vips 0.0.19, jimp 1.6.1, jsquash 1.6.0

## Correctness

| Fixture | wasm-vips | jimp | jsquash |
| --- | --- | --- | --- |
| `photo12mp_o1.jpg` | pass | pass | pass |
| `photo12mp_o3.jpg` | pass | pass | pass |
| `photo12mp_o6.jpg` | pass | pass | pass |
| `photo12mp_o8.jpg` | pass | pass | pass |
| `small_o2.jpg` | pass | pass | pass |
| `small_o4.jpg` | pass | pass | pass |
| `small_o5.jpg` | pass | pass | pass |
| `small_o7.jpg` | pass | pass | pass |
| `small_500x400.jpg` | pass | pass | pass |
| `exact_600x450.jpg` | pass | pass | pass |
| `over_601x400.jpg` | pass | pass | pass |
| `over_640x480.jpg` | pass | pass | pass |
| `tall_1000x3000.jpg` | pass | pass | pass |
| `progressive_2000x1500.jpg` | pass | pass | pass |
| `grayscale_2000x1500.jpg` | pass | pass | pass |
| `cmyk_2000x1500.jpg` | pass | pass | info |
| `png_alpha_disc_3000x2000.png` | pass | **FAIL** | pass |
| `png_alpha_small_300x200.png` | pass | pass | pass |
| `png_opaque_2400x1600.png` | pass | pass | pass |
| `webp_2000x1500.webp` | pass | info | pass |
| `gif_animated_1200x900.gif` | pass | pass | pass |
| `gif_static_1200x900.gif` | info | info | info |
| `p3_2000x1500.jpg` | pass | **FAIL** | **FAIL** |
| `corrupt_truncated.jpg` | pass | pass | pass |
| `not_an_image.jpg` | pass | pass | pass |
| `empty.jpg` | pass | pass | pass |
| `bomb_20000x20000.png` | pass | pass | pass |
| **Totals** | 26 pass, 0 fail, 1 info | 23 pass, 2 fail, 2 info | 24 pass, 1 fail, 2 info |

### Details for every non-pass

- `cmyk_2000x1500.jpg` / jsquash: **INFO**: failed: decode_failed: Error: [object Object]
- `png_alpha_disc_3000x2000.png` / jimp: **FAIL**: dark halo on edges (mean 32 below white); no EXIF
- `webp_2000x1500.webp` / jimp: **INFO**: not supported by this library (jimp cannot write webp)
- `gif_static_1200x900.gif` / wasm-vips: **INFO**: skipped: GIF is not resized in this spike
- `gif_static_1200x900.gif` / jimp: **INFO**: skipped: GIF is not resized in this spike
- `gif_static_1200x900.gif` / jsquash: **INFO**: skipped: GIF is not resized in this spike
- `p3_2000x1500.jpg` / jimp: **FAIL**: orientation/colour wrong: tl=(231, 51, 37), tr=(92, 199, 61), br=(252, 251, 83); no EXIF
- `p3_2000x1500.jpg` / jsquash: **FAIL**: orientation/colour wrong: tl=(231, 51, 37), tr=(90, 197, 59), br=(251, 250, 82); no EXIF

## Time and memory

Each case ran in its own process; run 1 starts a new worker thread and loads the library (cold), runs 2 and 3 reuse it (warm). RSS is the whole process (worker thread and WebAssembly memory included); the baseline is the process before the job (~90 MB).

| Fixture | Library | Cold total ms | Library init ms | Warm total ms | Warm steps (ms) | CPU ms (warm) | Peak RSS MB (process) | Output bytes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `photo12mp_o6.jpg` | wasm-vips | 1118 | 194 | 196 | decode+resize 179, encode 13 | 382 | 340.1 | 4836 |
| `photo12mp_o6.jpg` | jimp | 4263 | 209 | 4599 | decode 1342, resize 2212, encode 94 | 4877 | 500.5 | 13856 |
| `photo12mp_o6.jpg` | jsquash | 1361 | 96 | 715 | decode 168, resize 425, rotate 18, encode 37 | 720 | 552.3 | 4573 |
| `photo12mp_o1.jpg` | wasm-vips | 980 | 208 | 140 | decode+resize 7, encode 122 | 166 | 305.3 | 4654 |
| `photo12mp_o1.jpg` | jimp | 3487 | 178 | 3554 | decode 1214, resize 2233, encode 103 | 3902 | 490 | 13386 |
| `photo12mp_o1.jpg` | jsquash | 1396 | 95 | 778 | decode 170, resize 400, rotate 0, encode 38 | 788 | 560.4 | 4367 |
| `png_alpha_disc_3000x2000.png` | wasm-vips | 901 | 205 | 187 | decode+resize 8, encode 179 | 252 | 333.4 | 8157 |
| `png_alpha_disc_3000x2000.png` | jimp | 1428 | 242 | 996 | decode 143, resize 826, encode 20 | 1090 | 310.1 | 9872 |
| `png_alpha_disc_3000x2000.png` | jsquash | 837 | 87 | 277 | decode 56, resize 217, rotate 0, encode 2 | 310 | 362.2 | 15633 |
| `png_opaque_2400x1600.png` | wasm-vips | 887 | 215 | 45 | decode+resize 4, encode 39 | 67 | 299.2 | 5549 |
| `png_opaque_2400x1600.png` | jimp | 1036 | 200 | 516 | decode 91, resize 399, encode 19 | 576 | 255.8 | 1730 |
| `png_opaque_2400x1600.png` | jsquash | 677 | 89 | 217 | decode 36, resize 136, rotate 0, encode 2 | 250 | 290.7 | 13707 |
| `progressive_2000x1500.jpg` | wasm-vips | 908 | 225 | 94 | decode+resize 2, encode 87 | 137 | 311.2 | 8469 |
| `progressive_2000x1500.jpg` | jimp | 1579 | 198 | 1043 | decode 411, resize 519, encode 111 | 1166 | 295.1 | 17125 |
| `progressive_2000x1500.jpg` | jsquash | 722 | 100 | 242 | decode 78, resize 130, rotate 0, encode 33 | 248 | 268.4 | 5413 |
| `tall_1000x3000.jpg` | wasm-vips | 791 | 210 | 48 | decode+resize 4, encode 42 | 86 | 287.6 | 3491 |
| `tall_1000x3000.jpg` | jimp | 1479 | 255 | 902 | decode 270, resize 548, encode 78 | 1042 | 276.1 | 8023 |
| `tall_1000x3000.jpg` | jsquash | 678 | 100 | 191 | decode 43, resize 116, rotate 0, encode 14 | 196 | 252.6 | 3375 |
| `webp_2000x1500.webp` | wasm-vips | 1137 | 242 | 110 | decode+resize 2, encode 102 | 133 | 323.6 | 1680 |
| `webp_2000x1500.webp` | jimp | n/a | | | not supported by this library (jimp cannot write webp) | | | |
| `webp_2000x1500.webp` | jsquash | 785 | 110 | 298 | decode 93, resize 115, rotate 0, encode 43 | 361 | 265.8 | 1554 |

### Worst case over all fixtures

| Library | Highest process RSS MB | Slowest cold ms | Fixture of the slowest |
| --- | --- | --- | --- |
| wasm-vips | 340.1 | 1408 | `cmyk_2000x1500.jpg` |
| jimp | 500.5 | 4272 | `photo12mp_o3.jpg` |
| jsquash | 560.4 | 1721 | `photo12mp_o3.jpg` |
