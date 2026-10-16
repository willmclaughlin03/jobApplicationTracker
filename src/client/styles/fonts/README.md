# Repository-local Inter

`inter.js` loads the unmodified `InterVariable.woff2` through `next/font/local`.
DashboardShell and PublicPageShell share this module and retain `--font-dashboard`,
their scoped root classes, `font-dashboard`, and `display: swap`. The font is a
source input, so compiling these shells does not require a Google Fonts request.

## Provenance

- Upstream: [rsms/inter](https://github.com/rsms/inter), tag `v4.1`.
- Pinned commit: `e3a3d4c57d5ecc01453a575621882a384c1995a3`.
- Original path: `docs/font-files/InterVariable.woff2`.
- Exact source: <https://raw.githubusercontent.com/rsms/inter/e3a3d4c57d5ecc01453a575621882a384c1995a3/docs/font-files/InterVariable.woff2>.
- Size: **352,240 bytes**.
- Git blob SHA-1: `5a8d3e72ad7ffb62af3b146e1b1f54ab5813a212`.
- SHA-256: `693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3`.

The exact upstream SIL Open Font License 1.1 and copyright notice are retained in
`public/fonts/inter/LICENSE.txt`, served at `/fonts/inter/LICENSE.txt`.

- License source: <https://raw.githubusercontent.com/rsms/inter/e3a3d4c57d5ecc01453a575621882a384c1995a3/LICENSE.txt>.
- License size: **4,380 bytes**.
- License Git blob SHA-1: `9b2ca37b3ffc77391d8b2ebef4a974ef32bf46ea`.
- License SHA-256: `262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a`.

Acquisition verified both lengths and Git blob identities against the pinned
upstream tree before writing either file. SHA-256 values above were computed from
those verified bytes; they are not claimed to be published upstream checksums.
Neither file was transformed, subsetted or rebuilt.

## Verified font metadata and presentation limits

The existing host Next 16.2.12 bundled font parser reported:

- Family: `Inter Variable`; subfamily: `Regular`; PostScript name: `InterVariable`.
- Embedded version: `Version 4.001;git-9221beed3` (distinct from the upstream tag).
- Weight axis: 100-900, default 400; optical-size axis: 14-32, default 14.
- 2,937 glyphs and 2,852 encoded code points.
- Units per em: 2,048; ascent: 1,984; descent: -494; line gap: 0.
- All printable Basic Latin code points U+0020-U+007E are present. Additional
  checked characters: U+00A0, U+00A3, U+00A9, U+00E9, U+2013, U+2014, U+2018,
  U+2019, U+201C, U+201D, U+2022, U+2026 and U+20AC. This is not a claim of
  complete language coverage.

The loader declares normal style and the full weight range. It does not add an
italic asset; the preceding Google-font configuration also requested normal
style. Preload remains enabled, now for this full 352,240-byte font rather than
the Google loader's selected Latin subset. There is no local `subsets` option.

Next computes Arial fallback adjustments from the local font. Optical sizing
uses browser defaults with the asset's `opsz` axis; no CSS override is added.
Fallback metrics and optical sizing may differ from the previous Google-served
font. Pixel-identical appearance and layout shift have not been established;
compare public and dashboard typography in a separately approved runtime.

## Qualification boundary

The existing qualification runner selects committed blobs under `src` and
`public`, archives raw Git blob bytes, and checks their identities after transfer.
These assets fit that selection without runner or `.gitattributes` changes.
They must be committed into a new source manifest and verified in the fresh Linux
setup; the original failed source manifest and retained images cannot qualify
this change. Host parsing and mocked rendering tests do not prove that the pinned
Next 16.3.3 offline production build succeeds.
