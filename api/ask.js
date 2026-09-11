// /api/ask.js
// Deploy as a Vercel serverless function.
//
// Uses NVIDIA NIM for the chat model and Tavily for web search — NVIDIA's
// models have no built-in search grounding of their own, so Tavily's results
// are fetched first and handed to the model as context.
//
// Required environment variables:
//   NVIDIA_API_KEY - get one free at https://build.nvidia.com
//                     (no credit card required for the free tier)
//   TAVILY_API_KEY - get one free at https://tavily.com
//                     (1,000 searches/month, permanent free plan, no card)
//
// NVIDIA hosts many models under one API — check https://build.nvidia.com
// for the current catalog and swap NVIDIA_MODEL below if you want a
// different one. This picks a general-purpose instruct model as a
// reasonable default.

const NVIDIA_MODEL = 'meta/llama-3.3-70b-instruct';

const SYSTEM_PROMPT = `You are Compass, an investment research assistant. You will be given web search results alongside the user's question — use them to answer with current, specific information. Don't rely on memory for figures, prices, or recent news; if the search results don't cover something, say so rather than guessing.

Rules:
- Present objective, sourced analysis: what the data shows, what's being reported, relevant context. Never state a directional prediction ("it will go up/down") or a buy/sell/hold call as if it were a fact.
- When you use something from the search results, name the source plainly in your prose (e.g. "according to Reuters..."), and keep exact quotes under 15 words.
- If your answer includes a numeric series worth visualizing (a price trend, a comparison across a few items, historical returns), append ONE fenced block at the very end labeled chartdata containing ONLY valid JSON, nothing else in the block:
\`\`\`chartdata
{"type":"line or bar","title":"short title","labels":["...","..."],"series":[{"name":"series name","values":[1,2,3]}]}
\`\`\`
  Only include this block when you have real numbers from the search results — never invent figures.
- End every response that discusses a specific security or fund with one short line reminding the person this is informational, not financial advice.
- Keep responses focused — a few short paragraphs or a tight list, not an essay.`;

async function tavilySearch(query) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query,
      search_depth: 'basic',
      max_results: 6,
      include_answer: false,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.results || []; // [{ title, url, content }, ...]
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  try {
    const { history } = req.body; // [{role:'user'|'assistant', content: '...'}, ...]

    if (!Array.isArray(history) || history.length === 0) {
      return res.status(400).json({ error: 'history is required' });
    }

    const lastUserMsg = [...history].reverse().find(m => m.role === 'user');
    if (!lastUserMsg) {
      return res.status(400).json({ error: 'No user message found in history' });
    }

    // 1. Search the web for the latest question
    const results = await tavilySearch(lastUserMsg.content);
    const sourcesBlock = results.length
      ? 'Web search results:\n\n' + results.map((r, i) =>
          `[${i + 1}] ${r.title}\n${r.url}\n${(r.content || '').slice(0, 500)}`
        ).join('\n\n')
      : 'No web search results were found for this query — say so rather than guessing at figures.';

    // 2. Build the OpenAI-style message list NVIDIA's API expects, injecting
    //    the search results into the latest user turn.
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history.map(m => {
        if (m === lastUserMsg) {
          return { role: 'user', content: `${m.content}\n\n---\n${sourcesBlock}` };
        }
        return { role: m.role, content: m.content };
      }),
    ];

    // 3. Call NVIDIA NIM (OpenAI-compatible chat completions)
    const nvidiaRes = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.NVIDIA_API_KEY}`,
      },
      body: JSON.stringify({
        model: NVIDIA_MODEL,
        messages,
        temperature: 0.4,
        max_tokens: 1024,
      }),
    });

    const data = await nvidiaRes.json();

    if (data.error) {
      return res.status(502).json({ error: data.error.message || 'NVIDIA API error' });
    }

    if (!nvidiaRes.ok) {
      return res.status(502).json({
        error: `NVIDIA API returned ${nvidiaRes.status}: ${JSON.stringify(data).slice(0, 300)}`,
      });
    }

    const message = data.choices?.[0]?.message || {};
    // Some NVIDIA-hosted models (reasoning-capable ones) put the answer in
    // reasoning_content and leave content blank when "thinking" mode kicks
    // in. Fall back to it, and strip any <think>...</think> wrapper if the
    // model included one inline.
    let text = message.content || message.reasoning_content || '';
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    if (!text) {
      return res.status(502).json({
        error: `Model returned an empty response. Raw payload: ${JSON.stringify(data).slice(0, 400)}`,
      });
    }

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
