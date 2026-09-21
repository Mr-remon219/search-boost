/** Vercel's supported SDK owns the evaluation wire protocol. Imported only
 * when the canonical Jev URL names Vercel; credentials are always explicit.
 * API reference: https://vercel.com/kb/guide/typesafe-jev-and-ai-sdk
 */
export async function evaluateVercel({ apiKey, state, questions, signal, fetchImpl }) {
  const [{ experimental_evaluate: evaluate }, { createGateway }] = await Promise.all([
    import('ai'), import('@ai-sdk/gateway'),
  ])
  const typed = Object.fromEntries(Object.entries(questions).map(([id, q]) => [id,
    { ...q, type: q.type === 'noul' ? 'boolean' : q.type },
  ]))
  const gateway = createGateway({ apiKey, fetch: fetchImpl })
  const result = await evaluate({ model: gateway.evaluationModel('typesafe-ai/jev'),
    state, questions: typed, maxRetries: 0, abortSignal: signal })
  const confidence = result.providerMetadata?.typesafe?.confidence ?? {}
  const answers = Object.fromEntries(Object.entries(result.answers).map(([id, answer]) => [id,
    answer.type === 'boolean' ? { type: 'noul', noul: answer.probability }
      : { ...answer, ...(confidence[id] !== undefined ? { confidence: confidence[id] } : {}) },
  ]))
  return { model: 'typesafe-ai/jev', answers,
    usage: { input_tokens: result.usage?.inputTokens, output_tokens: result.usage?.outputTokens } }
}
