# Style Convention Extraction — {{SOURCE_NAME}}, Volume {{INSTALLMENT_NUMBER}}

**Series:** {{SOURCE_NAME}}
**Volume being processed:** {{INSTALLMENT_NUMBER}}
**Source language:** {{SOURCE_LANGUAGE}}
**Target language:** {{TARGET_LANGUAGE}}

## Materials Provided

Read the following materials **in full** before extracting anything:

1. **The source text of volume {{INSTALLMENT_NUMBER}}** — the only source you will receive for this volume. The **single source of truth** for which style-relevant constructs appear in volume {{INSTALLMENT_NUMBER}}.
2. **The previous style guide** (`style-guide-previous.md`) — the rendering policies already established from earlier volumes. *(Absent for the first volume.)*

## Task

Following the system prompt, analyze volume {{INSTALLMENT_NUMBER}}'s source text and produce a JSON array of style-relevant constructs:

1. **Catalog recurring constructs** — honorifics, pronouns, sentence-ending particles, internal-monologue markers, onomatopoeia, interjections, POV markers, scene breaks, tense/punctuation conventions, wordplay, and note-worthy cultural references.
2. **Skip what is already covered** — a construct with an existing rule in the previous style guide is listed only if this volume adds something new to it.

For each extraction, provide source-language quotes as examples.

## Output

Respond with **only** a JSON array — no prose, no markdown fences, no commentary. Each element is a construct entry as specified in the system prompt. If there is **nothing new to extract**, respond with an empty JSON array: `[]`
