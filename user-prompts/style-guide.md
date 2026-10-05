# Style Guide Compilation — {{SOURCE_NAME}}, Volume {{INSTALLMENT_NUMBER}}

**Series:** {{SOURCE_NAME}}
**Volume being processed:** {{INSTALLMENT_NUMBER}}
**Source language:** {{SOURCE_LANGUAGE}}
**Target language:** {{TARGET_LANGUAGE}}

## Materials Provided

Read the following materials **in full** before writing anything:

1. **The source text of volume {{INSTALLMENT_NUMBER}}** — the single source of truth for what recurs in this volume.
2. **The previous style guide** (`style-guide-previous.md`) — the rendering policies from earlier volumes. *(Absent for the first volume.)*
3. **The extraction results** (below) — new style-relevant constructs from this volume's source text.

Optional cross-reference material (read if present in your working folder — it informs the decisions but is not required):
- `glossary.md` — the current glossary snapshot (canonical names).
- `character-voice.md` — the current character voice reference (formality and voice data).

## Extraction Results

{{EXTRACTION_RESULTS}}

## Task

Following the system prompt, produce **one output file** for volume {{INSTALLMENT_NUMBER}}:

### The cumulative style guide
1. Carry forward every existing rule from the previous guide unchanged (unless extraction results reveal a correction).
2. Add a rule for every new construct in the extraction results that has no rule yet.
3. Amend existing rules only when this volume's evidence contradicts them — mark the amendment inline.
4. Park undecided constructs in "Open Questions" with their context.
5. Update the "Current through volume" header to volume {{INSTALLMENT_NUMBER}}.

## Output

Produce exactly this file:
1. `style-guide.md` — the complete cumulative style guide

Write it to `style-guide.md`. **How it is written is stated in your turn instructions** — the guide is cumulative, so from the second volume on it is amended in place rather than rewritten.

After writing, reply with a short summary.

## Constraints

- **No hallucination.** Every rule must be traceable to the source text or to the previous guide.
- **No rewriting of unflagged content.** The style guide carries forward existing rules unchanged unless extraction results reveal a correction.
- **Keep the templates intact.** Same section structure, headings, and writing style as the existing guide.
- **The style guide is cumulative** — carry forward everything.
