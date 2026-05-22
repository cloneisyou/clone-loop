export const ANSI_BOLD = '\u001b[1m'
export const ANSI_PURPLE = '\u001b[35m'
export const ANSI_RESET = '\u001b[0m'

export function purple(value) {
  return `${ANSI_PURPLE}${value}${ANSI_RESET}`
}

export function purpleBold(value) {
  return `${ANSI_BOLD}${ANSI_PURPLE}${value}${ANSI_RESET}`
}

export function formatPromptLines(value) {
  return String(value || '')
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
}

export function formatIterationPromptLine({ iteration, prompt }) {
  const [firstLine = '', ...remainingLines] = formatPromptLines(prompt)
  const continuation = remainingLines.length
    ? `\n${remainingLines.map((line) => purpleBold(`> ${line}`)).join('\n')}`
    : ''
  return `${purpleBold(`Iteration ${iteration} : ${firstLine}`)}${continuation}`
}

export function formatPredictedPromptSection({ iteration, predictedResponse, predictedConfidence, cloneThreshold, prediction }) {
  const roundedConfidence = Number(predictedConfidence).toFixed(5)
  return `${formatIterationPromptLine({ iteration, prompt: predictedResponse })}

Confidence: ${roundedConfidence} / threshold: ${cloneThreshold}
Prediction status: ${prediction.status || ''}
Prediction id: ${prediction.id || ''}`
}
