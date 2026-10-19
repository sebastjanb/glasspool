# Glass Pool

Billiards with real spin and cushions. 8-ball against three opponents, 9-ball and trick shots.

A game for Meta Ray-Ban Display glasses: one static page on a 600×600 canvas, no server, no account, own artwork.
The scene is WebGL through three.js (vendored as `site/three.module.min.js`, MIT, see `site/three-LICENSE.txt`); the HUD is a 2D canvas on top.

| Input | Action |
| --- | --- |
| Left / Right | turn the cue 1°; twice quickly jumps to the next ball |
| Up / Down | spin: none, follow, draw, left, right |
| Pinch | start the stroke, pinch again to strike |
| Back | leave the app |


On the glasses add `https://sebastjanb.github.io/glasspool/index.html` (keep `index.html`: without it the glasses read
the app manifest from the host root and show another app's icon).

## Files

- `site/game.js` — the game. Bump `VERSION` for every release.
- `site/kit.js` (and `kit3d.js` for WebGL games) — shared helpers, copied from `GlassArcade/kit/`; edit them there.
- `site/index.html`, `site/sw.js`, manifests — written by `GlassArcade/scaffold.py`, which also renames the cache from `VERSION`.
- `site/.well-known/meta-wearables-manifest.json` and `icon.png` — the name and icon the glasses show.

Publish: push to `main`; `.github/workflows/pages.yml` serves `site/` on GitHub Pages.
