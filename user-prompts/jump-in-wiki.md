# Jump-In Wiki Generation Request — Volume {{INSTALLMENT_NUMBER}}

**Series:** {{SOURCE_NAME}}
**Volume being processed:** {{INSTALLMENT_NUMBER}} (the latest volume available)
**Source language:** {{SOURCE_LANGUAGE}}

## Materials Provided

Read the following materials **in full** before writing anything:

1. **The source text of volume {{INSTALLMENT_NUMBER}}** of {{SOURCE_NAME}} — the only volume source you will receive. This is the **single source of truth** for what happens in volume {{INSTALLMENT_NUMBER}}.
2. **The shared wiki** (`jump-in-wiki-shared.md`) — the "living section" holding the series-general current state, as it stands before volume {{INSTALLMENT_NUMBER}} is processed.

*(If this is the first volume, only material 1 is provided. Materials 2 is absent.)*

## Task

Following the system prompt, produce **two output files** for volume {{INSTALLMENT_NUMBER}}:

### File 1: the volume wiki
Write the article for volume {{INSTALLMENT_NUMBER}} from its source text:
1. Use the full template: TL;DR, POV characters, setting, tone, plot summary, character changes, world/rule changes, unresolved threads.
2. Cover every major plot beat the volume actually contains — as many as needed, no cap.
3. Summarize only volume {{INSTALLMENT_NUMBER}} — do not re-summarize previous volumes, and do not preview or speculate about any volume beyond it.

### File 2: the updated shared wiki
Update the living section to reflect the full state through the end of volume {{INSTALLMENT_NUMBER}}:
1. Carry forward every section of the current shared wiki (Series Overview, Character Roster, Timeline of Key Events, World State & Rules, Glossary, Open Threads).
2. Apply only the changes that volume {{INSTALLMENT_NUMBER}}'s source actually causes: new characters, deaths or exits, world/rule changes, new factions or locations, and newly-opened or resolved threads.
3. A thread that volume {{INSTALLMENT_NUMBER}} resolves **leaves** the Open Threads section (move its resolution into the Timeline if it is still historically significant).
4. Update the "Current state through: Volume {{INSTALLMENT_NUMBER}}" header and the installment count in the Series Overview.

### Placement judgment (applies to both files)
- **What happened in this volume** → the volume wiki.
- **What the series looks like now** → the shared wiki.
- A volume event that creates or changes a lasting state may and should appear in **both** — the event in the volume wiki, the resulting state in the shared wiki. Duplication of facts is fine; **contradiction between the two files is not** — they must never disagree.

### Corrections to earlier wikis
If volume {{INSTALLMENT_NUMBER}}'s source reveals that an earlier volume wiki or the shared wiki was wrong (plot twist, hidden identity, corrected backstory):
- Update the **shared wiki** to include the newly revealed truth (it is the living document) and which volume this information was first revealed.
- If volume {{INSTALLMENT_NUMBER}} references a past event no earlier wiki covers, describe it only as the source recounts it and mark it "as recounted in volume {{INSTALLMENT_NUMBER}}".

## Output

Produce exactly these files:
1. `jump-in-wiki-{{INSTALLMENT_NUMBER}}.md` — the volume wiki for volume {{INSTALLMENT_NUMBER}}
2. `jump-in-wiki-shared.md` — the updated shared wiki (the complete file, not just the diff)

All content in both files written in **{{SOURCE_LANGUAGE}}** — the same language as the source material, including headings and labels.

## Output Format
your output will be saved directly to the new jumpin wiki as well as the shared wiki, hence, your output will be in the following format. Do **NOT** include additional text that is not in the follow the format.
```markdown
---- jump-in-wiki-{{INSTALLMENT_NUMBER}}.md ----

Contents of the jump in wiki

---- jump-in-wiki-shared.md ----

Updated contents of the shared jump in wiki.

---- end ----
```

## Constraints

- **No hallucination.** Every claim about volume {{INSTALLMENT_NUMBER}} must be traceable to its source text. If a detail is unclear or ambiguous, note the uncertainty explicitly rather than inventing an answer.
- **No memory-filling.** Do not reconstruct the contents of previous volumes from model memory — the provided volume wikis are your only record of them.
- **Do not rewrite history.** Earlier volume wikis stay identical except for marked, source-justified corrections. A validation pass will diff your output against them.
- **No speculative future state.** The shared wiki reflects what is known through volume {{INSTALLMENT_NUMBER}} only.
- When in doubt whether a detail matters to a newcomer, **include it**.
