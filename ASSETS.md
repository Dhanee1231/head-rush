# Assets (HD renderer)

Everything the HD renderer (`hd3d.js`) shows is generated at runtime in code; the HD look adds no image, model or audio files.

| What | Source |
|---|---|
| Matte-painted backdrops (Neon skyline and glyph billboards, Lava cliffs, temple silhouettes and lava falls, Frost aurora and peaks, Gear clock window and gear silhouettes, Carnival night sky, coaster and tent silhouettes, Orbit starfield and nebula) | Painted procedurally on a 2D canvas in `hd3d.js` (`backdrop()`, `skylineLayer()`, `glyphSign()`), seeded RNG |
| Board floors, roughness maps, platform side walls (incl. Gear tread plate, Orbit deck panels, Carnival boardwalk planks and bunting) | Procedural canvas drawing (`BOARD`, `boardBase()`, `sideTexture()`) |
| Gears, pipes, lamps, Orbit planet, rings, station and pylons, Ferris wheel, tents, string lights | three.js primitives, extruded shapes (`gearShape()`), merged/instanced in `hd3d.js`; planet bands and ring texture drawn on canvas |
| Steam, dust, space dust, fireflies | Soft radial-gradient sprite drawn on canvas (`softTex()`), `makePuffs()` / `motes()` |
| Runner bodies, arms, mittens, sneakers, faces | three.js primitives and lathe geometry; faces drawn on canvas (`faceTextures()`) |
| Crystals, basalt spires, rooftop props | Procedural geometry (`crystalGeo()`, `crag()`, `mergeBoxes()`) |
| Flames, reflections, glows, light pools | Canvas gradients |
| Environment lighting | three.js `RoomEnvironment` (MIT, vendored with three.js) |

All art is original. Nothing is taken from Fuzion Frenzy or any other game, and no paid or third-party art assets are used.
