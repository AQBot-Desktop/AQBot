import { isTauri } from '@/lib/invoke'
import type { Message } from '@/types'

function browserDownload(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

async function saveFile(
  defaultName: string,
  content: string | Uint8Array,
  filters: { name: string; extensions: string[] }[],
) {
  if (isTauri()) {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const { writeTextFile, writeFile } = await import('@tauri-apps/plugin-fs')
    const filePath = await save({ defaultPath: defaultName, filters })
    if (!filePath) return false
    try {
      if (typeof content === 'string') {
        await writeTextFile(filePath, content)
      } else {
        await writeFile(filePath, content)
      }
    } catch (e) {
      console.error('Failed to write file:', filePath, e)
      throw e
    }
    return true
  }
  // Browser fallback
  const mimeType = filters[0]?.extensions[0] === 'png' ? 'image/png' : 'text/plain'
  if (typeof content === 'string') {
    browserDownload(defaultName, content, mimeType)
  } else {
    const blob = new Blob([content], { type: mimeType })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = defaultName
    a.click()
    URL.revokeObjectURL(url)
  }
  return true
}

export async function exportAsMarkdown(messages: Message[], title: string) {
  const lines: string[] = [`# ${title}`, '']
  for (const m of messages) {
    const role = m.role === 'user' ? 'User' : m.role === 'system' ? 'System' : 'Assistant'
    lines.push(`## ${role}`, '', m.content, '', '---', '')
  }
  return saveFile(`${title}.md`, lines.join('\n'), [{ name: 'Markdown', extensions: ['md'] }])
}

export async function exportAsText(messages: Message[], title: string) {
  const lines: string[] = [title, '='.repeat(title.length), '']
  for (const m of messages) {
    const role = m.role === 'user' ? 'User' : m.role === 'system' ? 'System' : 'Assistant'
    lines.push(`[${role}]`, '', m.content, '', '---', '')
  }
  return saveFile(`${title}.txt`, lines.join('\n'), [{ name: 'Text', extensions: ['txt'] }])
}

export async function exportAsPNG(element: HTMLElement | null, title: string) {
  if (!element) return false
  const { default: html2canvas } = await import('html2canvas')
  const canvas = await html2canvas(element, { useCORS: true, scale: 2, backgroundColor: '#fff' })

  if (isTauri()) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) return false
    const buffer = new Uint8Array(await blob.arrayBuffer())
    return saveFile(`${title}.png`, buffer, [{ name: 'PNG Image', extensions: ['png'] }])
  }

  // Browser fallback
  const link = document.createElement('a')
  link.download = `${title}.png`
  link.href = canvas.toDataURL('image/png')
  link.click()
  return true
}

export async function exportAsJSON(messages: Message[], title: string) {
  const data = {
    title,
    exported_at: new Date().toISOString(),
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content,
      thinking: m.thinking,
      created_at: m.created_at,
    })),
  }
  return saveFile(`${title}.json`, JSON.stringify(data, null, 2), [{ name: 'JSON', extensions: ['json'] }])
}
