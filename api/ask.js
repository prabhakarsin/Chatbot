// /api/ask.js

// NVIDIA periodically retires models on an end-of-life schedule.
// These public-access identifiers ensure stable routing without account tier issues.
const NVIDIA_MODELS = [
  // 🟢 ACTIVE & STABLE: Highly efficient, fast, and optimized for data/coding tasks
  'deepseek-ai/deepseek-v3',

  // 🟢 ACTIVE & STABLE: Powerful alternative mixture-of-experts model for research
  'moonshotai/kimi-k3'
];

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
  const res = await fetch('https://tavily.com', {
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
  
  const bodyText = await res.text();
  let data;
  try {
    data = JSON.parse(bodyText);
  } catch (e) {
    throw new Error(`Tavily returned invalid JSON: ${bodyText.slice(0, 200)}`);
  }
  
  if (data.error) throw new Error(data.error);
  return data.results || [];
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  try {
    const { history } = req.body;

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

    // 2. Build the OpenAI-style message list
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history.map(m => {
        if (m === lastUserMsg) {
          return { role: 'user', content: `${m.content}\n\n---\n${sourcesBlock}` };
        }
        return { role: m.role, content: m.content };
      }),
    ];

    // 3. Call NVIDIA NIM with a clean loop
    let text = '';
    let lastError = null;

    for (const model of NVIDIA_MODELS) {
      const nvidiaRes = await fetch('https://nvidia.com', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.NVIDIA_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.4,
          max_tokens: 1024,
        }),
      });

      const bodyStr = await nvidiaRes.text();
      
      let data = {};
      try {
        data = JSON.parse(bodyStr);
      } catch (e) {
        // Response wasn't JSON, handle it as raw error text
      }

      const isRetiredOrMissing =
        nvidiaRes.status === 410 ||
        nvidiaRes.status === 404 ||
        /no longer available|not found/i.test(bodyStr);

      if (!nvidiaRes.ok || data.error) {
        lastError = `NVIDIA API (${model}) returned ${nvidiaRes.status}: ${bodyStr.slice(0, 300)}`;
        if (isRetiredOrMissing) continue; // Try the next model candidate
        break; // Stop loop on structural problems (e.g. invalid API key)
      }

      // 🔥 LOGIC FIX: Handle nested choices chaining properly
      const message = data.choices?.[0]?.message || {};
      text = (message.content || message.reasoning_content || '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .trim();

      if (text) break; // Success!
      lastError = `Model ${model} returned an empty response.`;
    }

    if (!text) {
      return res.status(502).json({
        error: lastError || 'All NVIDIA models failed with no further detail.',
      });
    }

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
