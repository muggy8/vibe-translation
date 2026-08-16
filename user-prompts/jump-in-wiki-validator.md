# Jump-In Wiki Validation Request — Volume {{INSTALLMENT_NUMBER}}

**Series:** {{SOURCE_NAME}}
**Volume being validated:** {{INSTALLMENT_NUMBER}}
**Source language:** {{SOURCE_LANGUAGE}}

## Materials Provided

Read the following materials **in full** before writing anything:

1. **The source text of volume {{INSTALLMENT_NUMBER}}** of {{SOURCE_NAME}} — the **single source of truth** for what happens in volume {{INSTALLMENT_NUMBER}}.
2. **The volume wiki for volume {{INSTALLMENT_NUMBER}}** (`jump-in-wiki-{{INSTALLMENT_NUMBER}}.md`) — the article generated from the source. **This is the primary document under audit.**
3. **The shared wiki (current)** (`jump-in-wiki-shared.md`) — the "living section" as regenerated after processing volume.{{INSTALLMENT_NUMBER}}. **Also under audit.**
4. **The shared wiki (previous state)** (`jump-in-wiki-shared.old.md`) — the previous state of the "living section" before it had been regenerated after processing volume.

*(If validating the first volume, materials 4 is absent and the earlier-volume consistency checks do not apply.)*

## Task

Following the system prompt (Series Continuity Auditor, adversarial mode), do **two things**:

### A. Validate correctness
1. **Read the source of volume {{INSTALLMENT_NUMBER}} first.** Build your own model of what actually happened, who changed, and what the world state is at the end. Do not anchor to the volume wiki's claims.
2. **Read the earlier volume wikis and the shared wiki.** Build your model of the established history and the claimed current state.
3. **Then attack the volume {{INSTALLMENT_NUMBER}} wiki and the shared wiki**, assuming they are broken:
   - **The volume wiki** — claims the source does not support, content the source contains that it skipped, muddled causality, places where a newcomer would finish still confused.
   - **The shared wiki update** — does it correctly reflect the state through volume {{INSTALLMENT_NUMBER}}? Any stale state, contradiction with a volume wiki, missing current-state information, or a resolved thread still listed as open?
4. **Apply the "newcomer test":** for each omitted or compressed passage in the volume wiki, ask whether a first-time reader of {{SOURCE_NAME}} could follow the story after reading the shared wiki + volume wiki together.

### B. Guide placement between the shared wiki and the volume wikis
5. Actively advise on the two-file split:
   - **"What happened in this volume"** belongs in the volume wiki; **"what the series looks like now"** belongs in the shared wiki.
   - Flag current-state information a newcomer needs that is **missing from the shared wiki**.
   - Flag volume-{{INSTALLMENT_NUMBER}} plot detail a newcomer would miss that is **missing from the volume wiki**.
   - Flag narrative-specific detail **wrongly placed in the shared wiki** (presented as persistent state when it belongs to one volume).
   - Flag any **contradiction** between the shared wiki and a volume wiki. Duplication of facts is allowed and often correct — only contradictions and valueless verbatim bloat are findings.
6. For every finding (correctness or placement), provide a concrete fix — exact replacement or insertion text, and say **which file** it goes in.

### Be honest about scope
7. You are verifying the volume {{INSTALLMENT_NUMBER}} wiki against its source, and the shared wiki for correctness and cross-file consistency. You do **not** have the original sources for volumes 1 through {{INSTALLMENT_NUMBER_MINUS_ONE}} and must not claim to have verified them against the source — you can only check them for internal and cross-file consistency.

## Output

Your output will be saved directly in `jump-in-wiki-validation-{{INSTALLMENT_NUMBER}}.md`. Ensure that you are following the format described in the system prompt. The entire report is written in **{{SOURCE_LANGUAGE}}** — the same language as the source material, including headings, labels, and suggested fix text (which must be usable directly as article content)

## Constraints

- **Quote the source for every error** in the volume {{INSTALLMENT_NUMBER}} wiki. No finding without a specific source passage behind it.
- **Quote the relevant wiki(s)** for every shared-wiki and placement finding.
- **No hallucinated errors.** If you are unsure whether something is wrong, mark it as "uncertain" and let the author decide — never present a guess as a confirmed error.
- **Ambiguous source material** (contradictions, retcons, unclear events) must be flagged for the author's judgment, not resolved by guessing.
- **Adversarial does not mean hostile** — every finding ends with a constructive fix.
