# Character Voice and Perspective Validation — {{SOURCE_NAME}}, Volume {{INSTALLMENT_NUMBER}}

**Series:** {{SOURCE_NAME}}
**Volume being validated:** {{INSTALLMENT_NUMBER}}
**Source language:** {{SOURCE_LANGUAGE}}
**Target language:** {{TARGET_LANGUAGE}}

## Materials Provided

Read the following materials **in full** before writing anything:

1. **The source text of volume {{INSTALLMENT_NUMBER}}** — the **single source of truth** for what characters, speech quirks, and POV patterns appear in this volume.
2. **The previous character voice reference** (`character-voice-previous.md`) — quirks and POV info from earlier volumes. *(Absent for the first volume.)*
3. **The amended character voice reference** (`character-voice.md`) — the document under audit (previous + this volume's additions).
4. **The POV map** (`pov-map.md`) — the per-volume POV tracking document under audit.

## Task

Following the system prompt (Character Voice and Perspective Auditor, adversarial mode), audit both output files for:

### Character Voice Reference
1. **Completeness** — every character in this volume's source has an entry; no quirks missed.
2. **No regressions** — every character from the previous reference is still present.
3. **Consistency** — no contradictory quirks for the same character.
4. **Correctness** — quirks match what the source text actually shows (verify with quotes).
5. **Examples** — every quirk has a direct source quote.
6. **Format** — well-formed Markdown, updated "Current through volume" header.

### POV Map
1. **Completeness** — every section with discernible POV is mapped; all POV markers identified.
2. **Marker identification** — all POV markers (※, ☆, etc.) listed and described.
3. **Narration type classification** — correct types for each section; free indirect discourse not missed.
4. **POV assignment** — markers correctly linked to characters; ambiguity flagged.
5. **Summary accuracy** — counts match the table; notable patterns mentioned.
6. **Format** — well-formed Markdown table.

For every finding, provide a concrete fix (exact text and section). Be honest about scope: you verify this volume's completeness against its source; you do not have the earlier volumes' sources.

## Output

Write the validation report to `character-voice-validation.md` using `writeFile` (complete contents, overwrite), in the exact format from the system prompt.

After writing the report, reply with a short summary of your findings.

## Constraints

- **Quote the source for every error.** No finding without a specific source passage behind it.
- **Quote the reference** for every inconsistency or regression.
- **No hallucinated errors.** If unsure, mark as "uncertain" — never present a guess as a confirmed error.
- **Ambiguous source material** must be flagged for the author's judgment.
- **Adversarial does not mean hostile** — every finding ends with a constructive fix.