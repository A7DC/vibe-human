# Export a rigged character for Darts World

This fork adds a dedicated game export. The original **Export GLB** panel and
`exportSession.ts` still produce a flattened, posed session export. Use the path
below when you need bones, animation and editable appearance in the game.

## Run the authoring export

```sh
npm install
npm run dev -- --host 127.0.0.1 --port 5190
```

Open **http://127.0.0.1:5190/vibe-human/game-export.html**. This is a development entry point:
the Draco decoder is served from `node_modules/three/examples/jsm/libs/draco/gltf/`.
The page shows export metrics and **Download character** / **Download manifest** links when finished. It exposes the result as
`window.gameExport` (`binary`, `manifest`, `metrics`), or an error as
`window.gameExportError`. T-shirts, hoodies, jackets and trousers run through the original clothing compiler,
sewing solver and render embedding during this offline authoring step. It does not
require opening the React character authoring UI. No cloth simulation runs in the
game. The result also exposes `authoringReport`, including seam gaps, remaining
movement and collision diagnostics; a step limit is not a convergence claim.

To save the result from the browser console:

```js
const { binary, manifest } = window.gameExport;
function save(data, name, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
save(new Uint8Array(binary), 'vibe-human.glb', 'model/gltf-binary');
save(JSON.stringify(manifest, null, 2), 'manifest.json', 'application/json');
```

Install both together in Darts World's `public/assets/character/`. The manifest URL
is `/assets/character/vibe-human.glb`. Keep the manifest beside the exact GLB that
produced it; mesh names and clothing IDs must agree. Darts World's
`Game.loadApprovedCharacter(manifest)` stages and validates separate world/preview
instances before replacing either live instance. Its startup option is
`GameOptions.characterManifest`.

## Sources and permission

Upstream: [vibe-stack/vibe-human](https://github.com/vibe-stack/vibe-human), based on
commit `6a61d0e770a6fb7039a96b32021cbbb3e5dd18a4`.
Fork: [A7DC/vibe-human](https://github.com/A7DC/vibe-human).
The user relayed the owner's permission: **“yes it is open source and you can use
it for your app”**, and explicitly requested this fork. That quoted permission is
the recorded basis for this app integration. No SPDX licence identifier has been
assigned by this export work.

Actual source assets are `public/human5.glb`,
`public/textures/colorfinal4k.jpg`, `public/textures/body/albedo.png` and
`public/textures/eyes.png`. The source human contains a 164-joint skeleton, separate
body/head primitives and bone-attached eyes. It has no embedded animation clips.
Hair variants use the existing scalp-guide, strand-generation and hair-card
helpers. Starter and purchasable tops use the upstream demo pattern with
editor-level sizing and placement adjustments, followed by the original
`compileGarmentRuntime`, `XPBDClothSolver` and `useGarmentSimulation` render
embedding helpers. The resulting drape receives skeleton weights and corrective
targets before export. Jacket/hoodie sleeves extend the same sewn pattern;
long sleeves use the existing gravity delay until seam assembly completes.
The body/head use the original solid mesh collider while trousers use its
two-sided surface-patch collider. The garment layer must not be merged into the
solid body collider: that incorrectly traps the shirt hem on the trouser rim.
Trousers use a new four-panel pattern authored in the same document system, with
waist pins during fitting and separate leg weights in the exported rig. The
folded hood uses two sewn panels; its attachment follows the final hoodie's
actual collar positions, rig weights and corrective targets. These are new
patterns authored with upstream's tools, not bundled upstream garment assets.
Shoes and caps remain fitted authoring additions. All cloth simulation and pins
are authoring-only; the playable game uses the resulting skinned meshes.
Locomotion clips are newly authored against the source rig.

## Helper contracts

- `authorUpstreamDemo(root, body, head, options)` runs the original panel compiler,
  sewing solver and render embedding offline. The game entry uses the sized demo
  panels and actual trousers as an authoring collision layer, then transfers rig
  weights and relative body correctives through the original render embedding.
  Sewn panel boundaries retain common positions, weights and corrective deltas.
  The inspection entry `game-upstream-garment.html` supports candidate fitting;
  `game-export.html` is the installation entry. A candidate is not automatically
  accepted for the game merely because export succeeds.
- `prepareGameCharacter(rawGLTF.scene, options)` clones the rig and geometry,
  restores its neutral pose, retains supported mass/jaw morphs and returns
  `{ root, body, head, controls, metrics }`. `body` and `head` remain in native
  authoring coordinates. The outer root converts the model to metres, a 1.78m
  height, feet at ground level and forward −Z.
- `buildGameStarterGarments(body)` or `buildGameCatalogGarments(body, head)`
  returns fitted meshes, body-region meshes and manifest garment mappings. Add
  returned meshes to the original body's parent, remove the original body, and
  set the build-control mesh to `body-exposed`.
- `buildGameGroom(head)` returns rigged hairstyle/facial-hair meshes and controls.
  Add its meshes to the head's parent and merge its controls into the manifest.
- `createGameAnimations(root)` returns `idle`, `walk`, `run`, `crouch` and `jump`
  clips. Physics supplies world movement; exported clips stay in place.
- `exportGameCharacter(root, { animations })` returns an uncompressed GLB
  `ArrayBuffer`, preserving skin attributes, bones, morphs and hidden variants.
  Export does not flatten the mesh into its current pose.

Head/body textures are reduced to 512px and neutralized so the selected skin tint
supplies color. The eye atlas is 256px; a separate masked iris material changes eye
color without tinting the sclera. Cloth fitting and hair generation happen only
here in authoring. The game uses rigged meshes and animation, with no cloth or
strand simulation.

Run `npx tsc -b` after changing helpers. Structural validation of the exported GLB
is useful but does not establish appearance quality. Verify the loaded game at
body-shape extremes, in all movement states and with each supported garment, and
inspect actual creator/world captures. Do not run Three's `SimplifyModifier` on
these meshes: it drops both morph and skin attributes. Mesh reduction needs a
separate rig-preserving authoring pass and deformation checks.

## Layered open jacket

The normal exporter uses `authorLayeredJacketOutfit` after authoring the complete
standalone hoodie and its sewn hood. It splits the original fitted front panel
into two genuinely open fronts, preserves the eight original shoulder/sleeve/
side seams, and deepens the free back neckline without moving its sewn endpoints.
Four original authoring pins hold the shoulders on the actual inner hoodie while
sewing; their relocated placement is included when refreshing seam rest lengths.
No pins or cloth solver run in the game.

Layer order is trousers → hoodie body → jacket → outside hood. The outside hood
keeps the exact inner hoodie's collar positions, weights and corrective deltas;
its initial free panels sit behind the measured outer jacket envelope. Garment
layers use the upstream two-sided surface patches with swept contact, which
prevents a step from tunnelling through a thin garment and choosing its inner
side. Body/head collision remains the solid-mesh path.

A jacket-only clone omits fully covered inner shoulder/sleeve triangles. The
open chest and collar remain real hoodie geometry; the standalone hoodie retains
its complete sleeves and separately authored hood. All jacket colour variants
share this cream inner layer and outer hood without additional inventory charges.
Their manifest bindings select the full outfit. The normal exporter preserves
both standalone and layered hood geometries and separate authoring reports.

The authoring run keeps 240 fixed steps and render embedding density 12. The more
complex jacket and layered hood allow an explicit 60-second wall guard each;
ordinary garments retain 20 seconds. Exceeding a guard fails export rather than
accepting a partial simulation. A completed run is a frozen neutral-body drape,
not a convergence claim or a separately simulated fit for every body shape.
The reviewed candidate improves layering and hood visibility; strong sleeve folds
and rough collar edges remain quality limitations requiring actual pose review.
