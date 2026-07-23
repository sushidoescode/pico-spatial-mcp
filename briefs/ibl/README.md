# Studio IBL fixture

`studio.ktx` is a generated conformance asset, not a redistributed photograph or SDK file.
On 2026-07-22, a fresh `pico-spatial-mcp` process produced it with:

```text
prepare_ibl_cubemap {
  "outKtx": "<repo>/briefs/ibl/studio.ktx",
  "preset": "studio",
  "size": 256
}
```

The `auto:studio` recipe in `src/iblbake.ts` authors a 1024×512 equirectangular PNG entirely
from declared hex colors and gradients, then runs Filament `cmgen` to produce a prefiltered KTX1
cubemap. The source PNG is LDR; the baked cubemap uses floating-point
`GL_R11F_G11F_B10F` faces and a roughness mip chain. Do not describe the generated source as HDR.

- Output: 2,095,508 bytes
- SHA-256: `ae560ba072dd5ce0b737e4bcc39839a95eda4e373b1f18fe17c34ca3facfd111`
- Shape: 256×256, 6 faces, 5 mip levels
- `cmgen`: official Filament 1.72.1 release (the binary exposes no version flag)
- `cmgen` binary SHA-256: `3f6addea973042dcd59f32e925198d339691b841069ef6c3e03ddaab5a224119`
- ImageMagick: 7.1.2-25 Q16-HDRI

The numeric preset and generated output are part of this Apache-2.0 project. No PICO SDK asset,
external environment image, or `cmgen` binary is included here.
