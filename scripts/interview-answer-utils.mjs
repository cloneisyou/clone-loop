import { escapeRegExp, normalizeText, numeric } from './clone-utils.mjs'

export function labelBoundaryMatch(text, label) {
  const normalizedLabel = normalizeText(label)
  if (!normalizedLabel) return false
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(normalizedLabel)}([^\\p{L}\\p{N}]|$)`, 'u').test(text)
}

export function mapPredictionToOption(predictedResponse, options = [], fallback = '') {
  const labels = options.map((option) => String(option?.label || '').trim()).filter(Boolean)
  if (!labels.length) return fallback

  const text = normalizeText(predictedResponse)
  const firstLine = normalizeText(String(predictedResponse || '').split(/\r?\n/).find((line) => line.trim()) || '')
  const letterMatch = text.match(/^(?:option\s*)?([a-j])(?:[.)\s:-]|$)/)
  if (letterMatch) {
    const index = letterMatch[1].charCodeAt(0) - 'a'.charCodeAt(0)
    if (labels[index]) return labels[index]
  }

  const exactMatches = labels.filter((label) => {
    const normalizedLabel = normalizeText(label)
    return normalizedLabel === text || normalizedLabel === firstLine
  })
  if (exactMatches.length === 1) return exactMatches[0]

  const prefixMatches = labels.filter((label) => {
    const normalizedLabel = normalizeText(label)
    return (
      text.startsWith(`${normalizedLabel} `) ||
      text.startsWith(`${normalizedLabel}.`) ||
      text.startsWith(`${normalizedLabel}:`) ||
      text.startsWith(`${normalizedLabel}-`)
    )
  })
  if (prefixMatches.length === 1) return prefixMatches[0]

  const containedMatches = labels.filter((label) => labelBoundaryMatch(text, label))
  return containedMatches.length === 1 ? containedMatches[0] : fallback
}

export function predictionCandidateText(candidate) {
  if (!candidate) return ''
  if (typeof candidate === 'string') return candidate
  return String(
    candidate.predicted_response ||
      candidate.response ||
      candidate.text ||
      candidate.content ||
      candidate.message ||
      '',
  )
}

export function predictionCandidateConfidence(candidate, fallback) {
  if (!candidate || typeof candidate === 'string') return fallback
  return numeric(
    candidate.confidence ??
      candidate.probability ??
      candidate.prob ??
      candidate.p ??
      candidate.score,
    fallback,
  )
}

export function rankedPredictionCandidates(prediction) {
  const candidates = []
  const topConfidence = numeric(prediction?.confidence, 0)

  if (prediction?.predicted_response) {
    candidates.push({
      text: String(prediction.predicted_response),
      confidence: topConfidence,
      index: candidates.length,
    })
  }

  for (const candidate of Array.isArray(prediction?.candidates) ? prediction.candidates : []) {
    const text = predictionCandidateText(candidate)
    if (!text) continue
    candidates.push({
      text,
      confidence: predictionCandidateConfidence(candidate, topConfidence),
      index: candidates.length,
    })
  }

  return candidates.sort((left, right) => right.confidence - left.confidence || left.index - right.index)
}
