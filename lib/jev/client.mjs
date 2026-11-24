// Compatibility facade: existing Jev callers retain their wire behavior and errors.
// New business code obtains a DecisionClient from lib/judgment/registry.mjs.
export {
  createDecisionTransport as createJevClient,
  JEV_DEFAULT_MODEL, JEV_ENDPOINT_PATH, JEV_ERROR_KINDS, JEV_FATAL_KINDS,
  JevError, jevEndpoint, safeServerDetail, classifyStatus, validateJevAnswers,
  estimateJevTokens,
} from '../judgment/transport.mjs'
