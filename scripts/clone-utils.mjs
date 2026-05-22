export function readStdin() {
  return new Promise((resolveRead) => {
    let input = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      input += chunk
    })
    process.stdin.on('end', () => resolveRead(input))
  })
}

export function parseJson(input) {
  const normalized = String(input || '').replace(/^\uFEFF/, '').trim()
  return normalized ? JSON.parse(normalized) : {}
}

export function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function numeric(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function stringValue(value) {
  return String(value || '').trim()
}

export function isIntegerString(value) {
  return /^[0-9]+$/.test(String(value || ''))
}

export function isPositiveInteger(value) {
  return /^[1-9][0-9]*$/.test(String(value || ''))
}

export function isThreshold(value) {
  return /^(0(\.[0-9]+)?|1(\.0+)?)$/.test(String(value || ''))
}

export function quoteYaml(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[`*_~"'“”‘’]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
