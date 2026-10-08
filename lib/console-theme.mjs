import { join } from 'node:path'
import { searchBoostHome } from './config-paths.mjs'
import { readJsonStore, withFileLock, writeFileAtomicPrivate } from './private-file.mjs'

// Console-only palette mappings; no dependency on the legacy TUI or terminal theme.
// Ayu: https://github.com/ayu-theme/ayu-colors/blob/master/themes/dark.yaml
// TokyoNight: https://github.com/folke/tokyonight.nvim/tree/main/lua/tokyonight/colors
export const DEFAULT_CONSOLE_THEME = 'ayu'
export const CONSOLE_THEMES = Object.freeze({
  ayu: Object.freeze({ id: 'ayu', name: 'Ayu', label: 'Ayu Dark', background: '#0d1017', foreground: '#bfbdb6',
    muted: '#8993a5', accent: '#e6b450', good: '#aad94c', warn: '#ffb454', danger: '#f07178', logo: '#e6b450', logoAlt: '#ff8f40' }),
  tokyonight: Object.freeze({ id: 'tokyonight', name: 'TokyoNight', label: 'TokyoNight Dark', background: '#1a1b26', foreground: '#c0caf5',
    muted: '#a9b1d6', accent: '#7aa2f7', good: '#9ece6a', warn: '#e0af68', danger: '#f7768e', logo: '#7aa2f7', logoAlt: '#bb9af7' }),
})
export const consoleSettingsPath = () => join(searchBoostHome(), 'config', 'console-tui.json')
function settingsDocument() {
  const { doc, error } = readJsonStore(consoleSettingsPath())
  if (error) throw error
  if (doc?.theme != null && !Object.hasOwn(CONSOLE_THEMES, doc.theme)) throw new Error('Unsupported console theme')
  return doc ?? {}
}
export function readConsoleTheme() { return settingsDocument().theme ?? DEFAULT_CONSOLE_THEME }
export function saveConsoleTheme(theme, { expectedTheme } = {}) {
  if (!Object.hasOwn(CONSOLE_THEMES, theme)) throw new Error('Unsupported console theme')
  const file = consoleSettingsPath()
  return withFileLock(file, () => {
    const doc = settingsDocument()
    if (expectedTheme !== undefined && (doc.theme ?? DEFAULT_CONSOLE_THEME) !== expectedTheme) throw new Error('Console theme changed')
    writeFileAtomicPrivate(file, `${JSON.stringify({ ...doc, theme }, null, 2)}\n`)
  })
}
export function consoleTheme(id) { return CONSOLE_THEMES[id] ?? CONSOLE_THEMES[DEFAULT_CONSOLE_THEME] }
const rgb = hex => [1, 3, 5].map(start => Number.parseInt(hex.slice(start, start + 2), 16)).join(';')
export function paintConsole(text, style, color, themeId) {
  if (!color) return text
  const theme = consoleTheme(themeId), selected = style === 'selected'
  const foreground = selected ? theme.background : theme[style] ?? theme.foreground
  const background = selected ? theme.accent : theme.background
  const bold = style === 'selected' || style === 'title' ? '1;' : ''
  return `\x1b[${bold}38;2;${rgb(foreground)};48;2;${rgb(background)}m${text}\x1b[0m`
}

// 12×12 silhouette sampled from assets/icon.png (the supplied SearchBoost logo).
// Six Braille cells × three rows keep the existing header height and pane geometry.
export const CONSOLE_LOGO = Object.freeze(['⣤⡀ ⢛⣿⣿', '⠈⢻⣶⠟⠁⠛', '⣴⠟⠁   '])
