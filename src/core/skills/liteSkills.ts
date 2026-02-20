import { App, TFile } from 'obsidian'

export type LiteSkillMode = 'lazy' | 'always'

export type LiteSkillEntry = {
  id: string
  name: string
  description: string
  mode: LiteSkillMode
  path: string
}

export type LiteSkillDocument = {
  entry: LiteSkillEntry
  content: string
}

const SKILL_DIR_PREFIX = 'YOLO/skills/'
const SKILL_FILE_SUFFIX = '.skill.md'

const normalizeSkillMode = (value: unknown): LiteSkillMode => {
  if (typeof value !== 'string') {
    return 'lazy'
  }
  return value.trim().toLowerCase() === 'always' ? 'always' : 'lazy'
}

const asTrimmedString = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const getFallbackSkillId = (file: TFile): string => {
  const basename = file.basename
  if (basename.endsWith('.skill')) {
    return basename.slice(0, -'.skill'.length)
  }
  return basename
}

const stripWrappingQuotes = (value: string): string => {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

const parseFrontmatterFromContent = (
  content: string,
): Record<string, string> | null => {
  if (!content.startsWith('---\n')) {
    return null
  }

  const closingIndex = content.indexOf('\n---\n', 4)
  if (closingIndex === -1) {
    return null
  }

  const frontmatterText = content.slice(4, closingIndex)
  const lines = frontmatterText.split('\n')
  const frontmatter: Record<string, string> = {}

  for (const line of lines) {
    const matched = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/)
    if (!matched) {
      continue
    }
    const key = matched[1]
    const value = stripWrappingQuotes(matched[2])
    frontmatter[key] = value
  }

  return frontmatter
}

const toLiteSkillEntry = ({
  file,
  frontmatter,
}: {
  file: TFile
  frontmatter?: Record<string, unknown> | null
}): LiteSkillEntry => {
  const fallbackId = getFallbackSkillId(file)
  const id = asTrimmedString(frontmatter?.id) ?? fallbackId
  const name = asTrimmedString(frontmatter?.name) ?? id
  const description =
    asTrimmedString(frontmatter?.description) ?? 'No description provided.'
  const mode = normalizeSkillMode(frontmatter?.mode)

  return {
    id,
    name,
    description,
    mode,
    path: file.path,
  }
}

const isLiteSkillFile = (file: TFile): boolean => {
  return (
    file.path.startsWith(SKILL_DIR_PREFIX) &&
    file.path.toLowerCase().endsWith(SKILL_FILE_SUFFIX)
  )
}

export function listLiteSkillEntries(app: App): LiteSkillEntry[] {
  const files = app.vault
    .getMarkdownFiles()
    .filter((file) => isLiteSkillFile(file))
    .sort((a, b) => a.path.localeCompare(b.path))

  return files.map((file) => {
    const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter
    return toLiteSkillEntry({
      file,
      frontmatter: frontmatter ?? null,
    })
  })
}

const findLiteSkillFile = ({
  app,
  id,
  name,
}: {
  app: App
  id?: string
  name?: string
}): TFile | null => {
  const normalizedId = id?.trim().toLowerCase()
  const normalizedName = name?.trim().toLowerCase()
  if (!normalizedId && !normalizedName) {
    return null
  }

  const files = app.vault
    .getMarkdownFiles()
    .filter((file) => isLiteSkillFile(file))
    .sort((a, b) => a.path.localeCompare(b.path))

  for (const file of files) {
    const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter
    const entry = toLiteSkillEntry({
      file,
      frontmatter: frontmatter ?? null,
    })
    if (normalizedId && entry.id.toLowerCase() === normalizedId) {
      return file
    }
    if (normalizedName && entry.name.toLowerCase() === normalizedName) {
      return file
    }
  }

  return null
}

export async function getLiteSkillDocument({
  app,
  id,
  name,
}: {
  app: App
  id?: string
  name?: string
}): Promise<LiteSkillDocument | null> {
  const file = findLiteSkillFile({ app, id, name })
  if (!file) {
    return null
  }

  const content = await app.vault.cachedRead(file)
  const parsedFrontmatter = parseFrontmatterFromContent(content)
  const entry = toLiteSkillEntry({
    file,
    frontmatter: parsedFrontmatter,
  })

  return {
    entry,
    content,
  }
}
