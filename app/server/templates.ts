// Templates in the vault's templates/ folder: listing them, filling a new piece from one, and the
// starter set, written only when the writer asks and never over a file that's already there.
// The starters give structure and questions, never prose: every line the writer will keep is theirs.
import { promises as fs } from 'node:fs'
import { applyTemplate as fillPiece, authorOf, templateInfo, type TemplateInfo } from '../src/lib/templates.ts'
import { findKind, kindName } from '../src/lib/kinds.ts'
import { splitFrontMatter } from '../src/lib/frontmatter.ts'
import { HttpError } from './net.ts'
import { loadSettings } from './settings.ts'
import { VAULT, listFiles, readDoc, resolveInVault, writeDoc } from './vault.ts'

export const TEMPLATES_FOLDER = 'templates'

const inTemplates = (rel: string) => /^templates\//i.test(rel)

/** Every template in the vault, by name. */
export async function listTemplates(): Promise<TemplateInfo[]> {
  const out: TemplateInfo[] = []
  for (const f of await listFiles()) {
    if (!inTemplates(f.path)) continue
    try {
      out.push(templateInfo(f.path, await readDoc(f.path)))
    } catch {
      /* gone since the listing: skip it */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Fill an empty new piece from a template. The piece keeps its title, created date and kind.
 * Returns where {{cursor}} put the caret: an offset into the body, or null.
 */
export async function applyTemplateTo(docPath: string, templatePath: string): Promise<{ cursor: number | null }> {
  if (!inTemplates(templatePath) || !templatePath.toLowerCase().endsWith('.md')) throw new HttpError(400, 'Not a template')
  let template: string
  try {
    template = await readDoc(templatePath)
  } catch {
    throw new HttpError(404, 'Template not found')
  }
  const doc = await readDoc(docPath)
  const { meta, body } = splitFrontMatter(doc)
  if (body.trim()) throw new HttpError(409, 'This piece already has writing in it. Use /template to add a template where the caret is.')
  const settings = await loadSettings()
  const ctx = { title: meta.title ?? '', kind: findKind(settings.kinds, meta.platform ?? '') ? kindName(settings.kinds, meta.platform!) : '', author: authorOf(settings), now: new Date() }
  const { content, cursor } = fillPiece(doc, template, ctx)
  await writeDoc(docPath, content, { reason: 'template' })
  return { cursor }
}

/** The folder templates go in: an existing top-level Templates/ (any case), or templates/. */
async function templatesFolder() {
  const dirs = await fs.readdir(VAULT, { withFileTypes: true }).catch(() => [])
  return dirs.find((d) => d.isDirectory() && d.name.toLowerCase() === TEMPLATES_FOLDER)?.name ?? TEMPLATES_FOLDER
}

/** Write the starter templates that aren't in the vault yet. Never replaces a file. */
export async function seedTemplates(): Promise<{ added: string[] }> {
  const folder = await templatesFolder()
  const added: string[] = []
  for (const s of STARTERS) {
    const rel = `${folder}/${s.file}`
    const there = await fs.access(resolveInVault(rel)).then(
      () => true,
      () => false,
    )
    if (there) continue
    await writeDoc(rel, s.content, { reason: 'create' })
    added.push(rel)
  }
  return { added }
}

const starter = (file: string, name: string, kind: string, body: string) => ({
  file,
  name,
  content: `---\ntemplate-name: ${name}\n${kind ? `template-for: ${kind}\n` : ''}---\n\n${body.trim()}\n`,
})

/** The built-in starter set. */
export const STARTERS = [
  starter(
    'academic-essay.md',
    'Academic essay',
    'essay',
    `
{{author}}

*Prompt: Your instructor's name*

*Prompt: The course name and number*

{{date:D MMMM YYYY}}

# {{title}}

## Introduction

{{cursor}}*Prompt: What question does this essay answer? End the paragraph with your thesis: the answer, in one arguable sentence.*

## Body

*Prompt: First reason for your thesis. Open with a topic sentence, give the evidence, then say how it supports the thesis.*

*Prompt: Second reason, with its own evidence.*

*Prompt: The strongest objection to your thesis, and your reply to it.*

## Conclusion

*Prompt: What does the reader understand now that they didn't at the start? Why does it matter beyond this essay?*

## Works Cited

*Prompt: Each source in MLA format, in alphabetical order by author.*
`,
  ),
  starter(
    'research-paper.md',
    'Research paper',
    'essay',
    `
# {{title}}

{{author}}

{{date:MMMM D, YYYY}}

## Abstract

{{cursor}}*Prompt: In 150 to 250 words: the question, what you did, what you found, and what it means. Write it last.*

## Introduction

*Prompt: What is known, what gap remains, and the question or hypothesis this paper tests.*

## Method

*Prompt: Participants or materials, the procedure, and how you analysed the results, in enough detail to repeat it.*

## Results

*Prompt: What you found, without interpreting it yet. Point to each table or figure.*

## Discussion

*Prompt: What the results mean for your question, how they fit earlier work, the study's limits, and what to study next.*

## References

*Prompt: Each source in APA format, in alphabetical order by author.*
`,
  ),
  starter(
    'lab-report.md',
    'Lab report',
    'essay',
    `
# {{title}}

{{author}} · {{date:D MMMM YYYY}}

## Aim

{{cursor}}*Prompt: What were you trying to find out or show?*

## Hypothesis

*Prompt: What did you expect to happen, and why?*

## Materials

*Prompt: The equipment and materials you used.*

## Method

*Prompt: The steps you followed, in order, so someone else could repeat them.*

## Results

*Prompt: Your measurements, in a table or graph, with units.*

## Analysis

*Prompt: What patterns do the results show? Include any calculations.*

## Conclusion

*Prompt: Was the hypothesis supported? What are the sources of error, and what would you change next time?*
`,
  ),
  starter(
    'linkedin-post.md',
    'LinkedIn post',
    'linkedin',
    `
{{cursor}}*Prompt: Hook. One line that makes someone stop scrolling: a surprising fact, a tension, or an admission.*

*Prompt: Story. The moment, the example or the numbers behind it, in short paragraphs.*

*Prompt: Point. What you learned, said plainly in a sentence or two.*

*Prompt: Close. A question for readers or a next step they can take.*

*Prompt: Under 1,300 characters. Only the first two lines show before "see more".*
`,
  ),
  starter(
    'youtube-script.md',
    'YouTube script',
    'youtube-script',
    `
# {{title}}

## Hook (0–10 s)

{{cursor}}*Prompt: The first thing the viewer sees and hears. Why should they keep watching?*

## Promise

*Prompt: What will the viewer know or be able to do by the end?*

## Beats

| Beat | Say | Show (B-roll) |
| --- | --- | --- |
| 1 |  |  |
| 2 |  |  |
| 3 |  |  |

## CTA

*Prompt: The one thing you want the viewer to do next.*
`,
  ),
  starter(
    'newsletter.md',
    'Newsletter',
    'blog',
    `
# {{title}}

{{date:MMMM D, YYYY}}

{{cursor}}*Prompt: A line or two on what this issue is about, and why now.*

## The main story

*Prompt: The one thing you most want readers to take away this time.*

## Worth your time

*Prompt: Links, books or ideas you found, each with a line on why it's worth a look.*

## Until next time

*Prompt: A question for readers, or what's coming in the next issue.*
`,
  ),
  starter(
    'cover-letter.md',
    'Cover letter',
    'email',
    `
{{author}}

{{date:MMMM D, YYYY}}

*Prompt: The hiring manager's name, the company and its address*

{{cursor}}*Prompt: Dear …, Which role you're applying for, and the one reason you're a strong fit.*

*Prompt: An achievement that shows you can do this job, with a number if you have one.*

*Prompt: Why this company in particular: something specific you know about it.*

*Prompt: Thank them, and say when you're available to talk.*

*Prompt: Sincerely, your name*
`,
  ),
  starter(
    'meeting-notes.md',
    'Meeting notes',
    '',
    `
# {{title}}

{{date:dddd, D MMMM YYYY}} · {{time}}

*Prompt: Who was there*

## Agenda

{{cursor}}*Prompt: What does this meeting need to decide or settle?*

## Notes

*Prompt: What was said, by topic.*

## Decisions

*Prompt: What was agreed.*

## Actions

*Prompt: Who does what, by when: one line each.*
`,
  ),
  starter(
    'book-notes.md',
    'Book notes',
    '',
    `
# {{title}}

*Prompt: Who wrote it, and when you read it*

## In a sentence

{{cursor}}*Prompt: What is the book about, in your own words?*

## Key ideas

*Prompt: The ideas you want to remember, each in a line or two.*

## Quotes

*Prompt: Passages worth keeping, with page numbers.*

## What I think

*Prompt: Where you agree, where you don't, and what you'll do differently.*

## Related

*Prompt: Notes or pieces this connects to. Type [[ to link one.*
`,
  ),
]
