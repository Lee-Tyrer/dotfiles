---
name: imagegen
description: Generate or edit raster image assets through Pi's ChatGPT/Codex subscription-backed image tool, or in bulk with the bundled batch script. Use for AI-created photos, illustrations, textures, sprites, product mockups, UI mockups, and transparent cutouts. Do not use for editable SVGs, existing vector/icon systems, or code-native graphics.
---

# Image Generation

Use the `imagegen` tool. Pi routes it through the authenticated `openai-codex` ChatGPT backend at Codex's `/backend-api/codex/images/generations` or `/edits` route. It uses the existing ChatGPT/Codex OAuth session and does **not** use `OPENAI_API_KEY` or OpenAI Platform API credits.

This is subscription-backed usage, so ChatGPT/Codex plan limits still apply. If the tool says login is required, use `/login` and choose `OpenAI (ChatGPT Plus/Pro)`. Do not silently switch to the paid Platform API.

## Tool or batch script

- **One or a few images:** use the `imagegen` tool. You see each result inline and can iterate.
- **Many images (roughly 5+), or the user asks for a batch:** use `scripts/imagegen.ts` in this skill directory. One process runs all requests in parallel, so never spawn extra agents or sessions for bulk generation.

## Batch script

Resolve `scripts/imagegen.ts` against this skill's directory and run it with `node` (Node 22 runs `.ts` directly). Run `node <skill-dir>/scripts/imagegen.ts --help` for all options.

```bash
# single image
node <skill-dir>/scripts/imagegen.ts --prompt "..." --out generated/cat.png --size 1024x1536 --quality low

# batch: one JSON job per line
node <skill-dir>/scripts/imagegen.ts --batch generated/jobs.jsonl --concurrency 4
```

Job line fields: `prompt` and `out` are required; `edit` (array of image paths), `size`, `quality`, `background`, `count`, and `model` are optional and match the tool parameters.

```json
{"prompt": "Head-and-shoulders studio portrait of an elderly man, grey background", "out": "generated/faces/face-001.png", "size": "1024x1024", "quality": "low"}
```

Batch workflow:

1. Write the jobs file into the workspace, with one distinct prompt and unique `out` path per image.
2. Run the script. It prints one line per finished job and a summary with wall time.
3. Existing outputs are skipped, so rerunning the same file resumes an interrupted batch. Failed jobs are written to `<jobs>.failed.jsonl`; rerun that file to retry them. The exit code is non-zero if any job failed.
4. Inspect a few sample outputs with the read tool rather than every image.
5. Report the output directory, counts, and wall time.

Script notes:

- Paths are relative to the current directory. Outputs are never overwritten.
- It reads the access token from `~/.pi/agent/auth.json` and never refreshes it. If it reports an expired token, ask the user to open pi so the login refreshes, then rerun.
- Default concurrency is 4. Each low-quality image takes about 15s, so 4 in parallel gives roughly 4x throughput. Rate-limit (429) responses are retried with backoff.
- Each PNG is about 2 MB.

## Workflow

1. Decide whether this is `generate` or `edit`.
   - Use `edit` when changing one or more supplied local images while preserving specified elements.
   - Use `generate` when there are no input images.
   - If images are supplied only as references for style or mood, describe that role clearly; local image inputs are sent through the Codex edit endpoint.
2. Treat the result as a project asset by default. Use preview-only mode only when the user explicitly asks not to save it.
3. Build a concise, structured prompt. Preserve detailed user requests; add only details that materially improve a vague request.
4. For edits, state invariants explicitly: `Change only X; keep Y unchanged.`
5. By default, pass a workspace-relative `outputPath` ending in `.png` (for example, `generated/smiley-face.png`). Do not overwrite existing assets; choose a versioned sibling path instead.
6. Call `imagegen` using the default ChatGPT/Codex route.
7. Inspect the returned image, then make at most one targeted change per iteration.
8. Report the saved path and final prompt.

## Tool behavior

- Default model: `gpt-image-2`.
- Default size, quality, and background: `auto`.
- The Codex backend ignores the `size` request field and always renders about 1.57 megapixels, picking the shape from the prompt. The tool and the batch script both turn `size` into an aspect hint in the prompt and only accept `auto`, `1024x1024` (renders about 1254x1254), `1536x1024`, and `1024x1536`. Smaller resolutions are not available; resize locally if needed.
- Saving is the default: supply `outputPath` unless the user explicitly requests a preview-only result.
- Up to five local reference/edit images are supported, matching Codex's built-in tool.
- Generated output is returned as PNG image data. Use a `.png` output path.
- `count` creates variants of one prompt; distinct assets need separate calls.
- `quality`, `background`, and `model` may be supplied when useful, but the normal path should stay on the Codex-backed defaults.
- The tool adds the ChatGPT account header and Codex image-turn header automatically; never ask the user to paste tokens or API keys.

## Prompt structure

Use only the fields that help:

```text
Use case: <product-mockup | illustration-story | ui-mockup | infographic-diagram | ...>
Asset type: <where it will be used>
Primary request: <main request>
Input images: <Image 1: edit target/reference; Image 2: ...> (optional)
Scene/backdrop: <environment>
Subject: <main subject>
Style/medium: <photo | illustration | 3D | ...>
Composition/framing: <framing and useful negative space>
Lighting/mood: <lighting and mood>
Color palette: <palette>
Materials/textures: <surface details>
Text (verbatim): "<exact text>"
Constraints: <must keep and must avoid>
Avoid: <negative constraints>
```

### Specificity policy

- If the user's request is already detailed, normalize it without inventing requirements.
- If it is generic, add only useful composition, framing, polish, or layout guidance.
- Do not add unrequested characters, props, slogans, brand names, palettes, or narrative beats.
- For exact in-image text, quote it verbatim, specify placement and typography, and require no extra text.
- For edits, repeat the invariants on every iteration.

## Transparent images

Match Codex's native path: request a genuinely transparent background in the prompt and preserve any returned alpha channel, for example: `transparent background, clean edges, no halo`. The default `gpt-image-2` request keeps the backend background control at `auto`; do not switch to the paid Platform API just to obtain transparency. If the returned image is not actually transparent, report that limitation or post-process it locally when appropriate.

## Generate vs edit

- No input image: use `operation: "generate"` or omit `operation`.
- Existing local image to modify: use `operation: "edit"` and pass `imagePaths`.
- In edit prompts, identify each image by index and role and say exactly what must remain unchanged.
- Keep edits non-destructive and save to a new sibling path by default.

## Use `imagegen` for

- New raster artwork, product shots, covers, mockups, illustrations, textures, sprites, and visual variants.
- Editing an existing raster image while preserving specified elements.
- UI mockups, infographics, diagrams, and image-based presentation visuals.

## Do not use `imagegen` for

- Extending an existing SVG, logo, icon set, or editable vector asset.
- Simple diagrams, wireframes, or shapes better made with HTML, CSS, SVG, or canvas.
- Small deterministic edits to a project-local asset when the source is already editable.
- Work where the user clearly wants deterministic code-native output.

## Output policy

- Project-bound images must be written into the workspace with `outputPath`.
- Preview-only images may omit `outputPath`; keep the generated result inline only when the user explicitly requests preview-only output.
- Never overwrite an existing output unless the user explicitly requests replacement.
- Always report the final workspace path for project assets and whether the ChatGPT/Codex subscription-backed route was used.
- For batches, report the output directory, ok/skipped/failed counts, and wall time instead of listing every file.
