# Character Voice and Perspective Extraction — {{SOURCE_NAME}}, Volume {{INSTALLMENT_NUMBER}}

**Series:** {{SOURCE_NAME}}
**Volume being processed:** {{INSTALLMENT_NUMBER}}
**Source language:** {{SOURCE_LANGUAGE}}
**Target language:** {{TARGET_LANGUAGE}}

## Materials Provided

Read the following materials **in full** before extracting anything:

1. **The source text of volume {{INSTALLMENT_NUMBER}}** — the only source you will receive for this volume. The **single source of truth** for which characters, speech quirks, and POV patterns appear in volume {{INSTALLMENT_NUMBER}}.
2. **The previous character voice reference** (`character-voice-previous.md`) — the quirks and POV info already collected from earlier volumes. *(Absent for the first volume.)*

## Task

Following the system prompt, analyze volume {{INSTALLMENT_NUMBER}}'s source text and produce a JSON array of voice quirks and POV analysis:

1. **Extract character voice quirks** — every character's distinctive speech patterns, vocabulary, formality, catchphrases, dialect, and internal voice.
2. **Analyze POV patterns** — POV markers (※, ☆, etc.), narration types (first-person-internal, free-indirect, third-person-omniscient, etc.), POV assignments, and free indirect discourse instances.

For each extraction, provide source-language quotes as examples.

## Output

Respond with **only** a JSON array — no prose, no markdown fences, no commentary. Each element is either a voice quirk entry or a POV analysis entry as specified in the system prompt. If there is **nothing new to extract**, respond with an empty JSON array: `[]`