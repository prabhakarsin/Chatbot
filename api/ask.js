// /api/ask.js
// Deploy as a Vercel serverless function.
const { OpenAI } = require('openai');

// NVIDIA periodically retires models on an end-of-life schedule.
// These exact string paths match the active public catalog.
const NVIDIA_MODELS = [
  'meta/llama-3.3-70b-instruct',
  'nvidia/llama-3.1-nemotron-70b-instruct'
];

const SYSTEM_PROMPT = `You are Compass, an investment research assistant. You will be given web search results alongside the user's question — use them to answer with current, specific information. Don't rely on memory for figures, prices, or recent news; if the search results don't cover something, say so rather than guessing.

Rules:
- Present objective, sourced analysis: what the data shows, what's being reported, relevant context. Never state a directional prediction ("it will go up/down") or a buy/sell/hold call as if it were a fact.
- When you use something from the search results, name the source plainly in your prose (e.g. "according to Reuters..."), and keep exact quotes under 15 words.
- If your answer includes a numeric series worth visualizing (a price trend, a comparison across a few items, historical returns), append ONE fenced block at the very end labeled chartdata containing ONLY valid JSON, nothing else in the block:
\`\`\`chartdata
{"type":"line or bar","title":"short title","labels":["...","..."],"series":[{"name":"series name","values":[]}]}
\`\`\`
  Only include this block when you have real numbers from the search results — never invent figures.
- End every response that discusses a specific security or fund with one short line reminding the person this is informational, not financial advice.
- Keep responses focused — a few short paragraphs or a tight list, not an essay.`;

async function tavilySearch(query) {
  if (!process.env.TAVILY_API_KEY) return [];
  try {
    // 💡 FIX 1: Corrected the endpoint URL to point to the actual Tavily API router
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
    const bodyText = await res.text();
    if (!bodyText) return [];
    const data = JSON.parse(bodyText);
    return data.results || [];
  } catch (err) {
    return [];
  }
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

    // 1. Fetch live web groundings safely
    const results = await tavilySearch(lastUserMsg.content);
    const sourcesBlock = results.length
      ? 'Web search results:\n\n' + results.map((r, i) =>
          `[${i + 1}] ${r.title}\n${r.url}\n${(r.content || '').slice(0, 500)}`
        ).join('\n\n')
      : 'No web search results were found for this query.';

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history.map(m => {
        if (m === lastUserMsg) {
          return { role: 'user', content: `${m.content}\n\n---\n${sourcesBlock}` };
        }
        return { role: m.role, content: m.content };
      }),
    ];

    // 💡 FIX 2: Corrected the base URL to point to NVIDIA's official NIM API route gateway
    const openai = new OpenAI({
      apiKey: process.env.NVIDIA_API_KEY,
      baseUrl: 'https://integrate.api.nvidia.com/v1',
    });

    let finalResponseText = '';
    let lastError = null;

    // 2. Loop through candidate endpoints safely
    for (const model of NVIDIA_MODELS) {
      try {
        const stream = await openai.chat.completions.create({
          model,
          messages,
          temperature: 0.4,
          max_tokens: 1024,
          stream: true,
        });

        let accumulatedText = '';
        for await (const chunk of stream) {
          const content = chunk.choices[0]?.delta?.content || '';
          accumulatedText += content;
        }

        finalResponseText = accumulatedText
          .replace(/<think>[\s\S]*?<\/think>/gi, '')
          .trim();

        if (finalResponseText) break; // Success, exit the fallback loop
      } catch (err) {
        lastError = `Model ${model} failed: ${err.message}`;
        // Automatically checks if error indicates fallback is needed
        if (err.status === 404 || err.status === 410 || /not found|retired/i.test(err.message)) {
          continue;
        }
        break; // Break if it's a structural error (e.g., bad API key authorization)
      }
    }

    if (!finalResponseText) {
      return res.status(502).json({
        error: lastError || 'All endpoint loops failed to execute response output.',
      });
    }

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ text: finalResponseText });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
