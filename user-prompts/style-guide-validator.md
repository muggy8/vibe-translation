# Style Guide Validation — {{SOURCE_NAME}}, Volume {{INSTALLMENT_NUMBER}}

**Series:** {{SOURCE_NAME}}
**Volume being validated:** {{INSTALLMENT_NUMBER}}
**Source language:** {{SOURCE_LANGUAGE}}
**Target language:** {{TARGET_LANGUAGE}}

## Materials Provided

Read the following materials **in full** before writing anything:

1. **The source text of volume {{INSTALLMENT_NUMBER}}** — the **single source of truth** for what recurs in this volume.
2. **The previous style guide** (`style-guide-previous.md`) — the rendering policies from earlier volumes. *(Absent for the first volume.)*
3. **The amended style guide** (`style-guide.md`) — the document under audit (previous + this volume's additions).

## Task

Following the system prompt (Style Guide Auditor, adversarial mode), audit the style guide for:

1. **Completeness** — every recurring construct in this volume's source has a rule or an Open Question; nothing missed.
2. **No regressions** — every rule from the previous guide is still present.
3. **Consistency** — no two rules give different renderings for the same construct.
4. **Correctness** — rules match what the source text actually shows (verify with quotes).
5. **Actionability** — every rule states a concrete rendering decision with context and exceptions.
6. **Examples** — every rule is backed by a direct source quote.
7. **Format** — well-formed Markdown, updated "Current through volume" header.

For every finding, provide a concrete fix (exact text and section). Be honest about scope: you verify this volume's completeness against its source; you do not have the earlier volumes' sources.

## Output

Write the validation report to `style-guide-validation.md` using `writeFile` (complete contents, overwrite), in the exact format from the system prompt.

After writing the report, reply with a short summary of your findings.

## Constraints

- **Quote the source for every error.** No finding without a specific source passage behind it.
- **Quote the guide** for every contradiction or regression.
- **No hallucinated errors.** If unsure, mark as "uncertain" — never present a guess as a confirmed error.
- **Ambiguous source material** must be flagged for the author's judgment.
- **Adversarial does not mean hostile** — every finding ends with a constructive fix.
