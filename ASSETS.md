# Assets (HD renderer)

Everything the HD renderer (`hd3d.js`) shows is generated at runtime in code; the HD look adds no image, model or audio files.

| What | Source |
|---|---|
| Matte-painted backdrops (Neon skyline and glyph billboards, Lava cliffs, temple silhouettes and lava falls, Frost aurora and peaks) | Painted procedurally on a 2D canvas in `hd3d.js` (`backdrop()`, `skylineLayer()`, `glyphSign()`), seeded RNG |
| Board floors, roughness maps, platform side walls | Procedural canvas drawing (`BOARD`, `boardBase()`, `sideTexture()`) |
| Runner bodies, arms, mittens, sneakers, faces | three.js primitives and lathe geometry; faces drawn on canvas (`faceTextures()`) |
| Crystals, basalt spires, rooftop props | Procedural geometry (`crystalGeo()`, `crag()`, `mergeBoxes()`) |
| Flames, reflections, glows, light pools | Canvas gradients |
| Environment lighting | three.js `RoomEnvironment` (MIT, vendored with three.js) |

All art is original. Nothing is taken from Fuzion Frenzy or any other game, and no paid or third-party art assets are used.
