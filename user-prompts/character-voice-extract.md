# Character Voice and Perspective Extraction — {{SOURCE_NAME}}, Volume {{INSTALLMENT_NUMBER}}

**Series:** {{SOURCE_NAME}}
**Volume being processed:** {{INSTALLMENT_NUMBER}}
**Source language:** {{SOURCE_LANGUAGE}}
**Target language:** {{TARGET_LANGUAGE}}

## Materials Provided

Read the following materials **in full** before extracting anything:

1. **The source text of volume {{INSTALLMENT_NUMBER}}** — the only source you will receive for this volume. The **single source of truth** for which characters, speech quirks, and POV patterns appear in volume {{INSTALLMENT_NUMBER}}.
2. **What this record already knows about the characters in this chapter** — the claims this series' reference record **currently** stands behind about the characters this chapter's own text names, established by the volumes before this one. It is a query over the record, not a copy of an earlier file: a claim a later volume replaced is not in it. *(A first volume's record carries none, and a chapter that names nobody the record can see is told exactly that.)*

## Task

Following the system prompt, analyze volume {{INSTALLMENT_NUMBER}}'s source text and produce the voice-quirk and POV-analysis entries it describes:

1. **Extract character voice quirks** — every character's distinctive speech patterns, vocabulary, catchphrases, and internal voice, plus the answer to each register question this series declares (named in the system prompt), where this volume's text shows one.
2. **Analyze POV patterns** — the perspective markers **this volume** prints, whatever they look like, the narration types, POV assignments, and free indirect discourse instances.

For each extraction, provide source-language quotes as examples.

## Output

Respond with **only** a JSON object holding one key, `entries` — no prose, no markdown fences, no commentary. Each element of `entries` is either a voice quirk entry or a POV analysis entry as specified in the system prompt. If there is **nothing new to extract**, respond with an object holding an empty array: `{"entries": []}`