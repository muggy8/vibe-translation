# Jump-In Wiki Feedback Application - Volume {{INSTALLMENT_NUMBER}}

**Series:** {{SOURCE_NAME}}
**Volume being corrected:** {{INSTALLMENT_NUMBER}}
**Source language:** {{SOURCE_LANGUAGE}}

## Materials Provided

Read the following materials **in full** before changing anything:

1. **The source text of volume {{INSTALLMENT_NUMBER}}** of {{SOURCE_NAME}} - the **single source of truth** for what happens in volume {{INSTALLMENT_NUMBER}}. Use it to verify every fix before applying it.
2. **The validation report** (`jump-in-wiki-validation-{{INSTALLMENT_NUMBER}}.md`) - the audit of the current wiki. This is your work order.
3. **The current volume wiki** (`wiki.md`) - the article to be corrected.
4. **The current shared wiki** (`shared-wiki.md`) - the living section to be corrected.
5. **The previous volume (N - 1) wiki** (`wiki.md` from the previous volume folder) - the previous version of the jump in wiki.
6. **The previous shared wiki** (`shared-wiki.md` previous version, path in the materials list) - the living section prior to any changes made to incorporate any of the current volume's information.

*(If working on the first volume, materials 5 and 6 is absent and the earlier-volume consistency checks do not apply.)*

## Task

Following the system prompt (Series Continuity Archivist, revision mode), apply the validation report's feedback to correct the two files:

1. **Work through every finding** in the report - errors, missing content, shared-wiki issues, placement & duplication issues, structural, appropriateness, and narrative-coherence issues.
2. **Verify each factual fix against the source** before applying it. If the source does not support a suggested fix, do not apply it.
3. **Apply by severity:** critical and warning findings are applied (after verification); nitpicks only when clearly correct and low-risk; uncertain findings are left unchanged.
4. **Apply placement fixes** by moving content between the two files, keeping both consistent.
5. **Preserve everything the report did not flag.** Make the smallest change that resolves each valid finding.

## Output

Produce exactly these two corrected files (the **complete** files, not just the diff):
1. `wiki.md` - the corrected volume wiki
2. `shared-wiki.md` - the corrected shared wiki

All content in both files written in **{{SOURCE_LANGUAGE}}** - the same language as the source material, including headings and labels.

## Output

Write the corrected volume wiki to `wiki.md` using `writeFile` (complete contents, overwrite).
Write the corrected shared wiki to `shared-wiki.md` using `writeFile` (complete contents, overwrite).
After writing both files, reply with a short summary.

## Constraints

- **No hallucination.** Every applied fix must be traceable to the source text or to a valid placement correction. If a suggested fix is not supported by the source, do not apply it.
- **Do not rewrite unflagged content.** The change set must be minimal and traceable to the validation report.
- **Keep the templates and style intact.** Same section structure, headings, and writing style as the existing wiki.
- **Keep the two files consistent.** No contradiction between the corrected volume wiki and the corrected shared wiki.
- **Uncertain findings are not applied.** Leave any content based on an uncertain finding unchanged.
