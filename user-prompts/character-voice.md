# Character Voice Compilation — {{SOURCE_NAME}}, Volume {{INSTALLMENT_NUMBER}}

**Series:** {{SOURCE_NAME}}
**Volume being processed:** {{INSTALLMENT_NUMBER}}
**Source language:** {{SOURCE_LANGUAGE}}
**Target language:** {{TARGET_LANGUAGE}}

## Materials Provided

Read the following materials **in full** before writing anything:

1. **The source text of volume {{INSTALLMENT_NUMBER}}** — the single source of truth for what appears in this volume.
2. **The previous character voice reference** (`character-voice-previous.md`) — quirks and POV info from earlier volumes. *(Absent for the first volume.)*
3. **The extraction results** (below) — new voice quirks and POV analysis from this volume's source text.

## Extraction Results

{{EXTRACTION_RESULTS}}

## Task

Following the system prompt, produce **two output files** for volume {{INSTALLMENT_NUMBER}}:

### File 1: the cumulative character voice reference
1. Carry forward every existing character entry from the previous reference unchanged (unless extraction results reveal a correction).
2. Add new characters found in this volume with all their quirks.
3. Update existing character entries only when new information from this volume adds or corrects quirks.
4. Update the "Appears in" list for each character to include this volume.
5. Update the "Current through volume" header to volume {{INSTALLMENT_NUMBER}}.

### File 2: the per-volume POV map
1. Map every POV marker (※, ☆, etc.) in the source text to its assigned character.
2. Classify every section's narration type (first-person-internal, free-indirect, third-person-omniscient, etc.).
3. Identify free indirect discourse — 3rd-person narration that adopts a character's voice.
4. Provide a POV shift summary with counts and notable patterns.
5. Flag any sections where POV is ambiguous.

## Output

Produce exactly these files:
1. `character-voice.md` — the complete cumulative character voice reference
2. `pov-map.md` — the per-volume POV map for volume {{INSTALLMENT_NUMBER}}

All content written in **{{SOURCE_LANGUAGE}}** — the same language as the source material, including headings, labels, and example quotes.

Write both files to the names above. **How each one is written is stated in your turn instructions** — the cumulative reference is amended in place, the per-volume POV map is written whole.

After writing, reply with a short summary.

## Constraints

- **No hallucination.** Every quirk and POV observation must be traceable to the source text or to the previous reference.
- **No rewriting of unflagged content.** The character voice reference carries forward existing entries unchanged unless extraction results reveal a correction.
- **Keep the templates intact.** Same section structure, headings, and writing style as the existing reference.
- **The character voice reference is cumulative** — carry forward everything. The POV map is per-volume.