// /api/ask.js
// Deploy as a Vercel serverless function.

// NVIDIA periodically retires models on an end-of-life schedule. 
// Standard format for public API keys uses these specific vendor handles.
const NVIDIA_MODELS = [
  // 🟢 CURRENT & ACTIVE: Premium data-processing engine on public tiers
  'deepseek-ai/deepseek-v3',

  // 🟢 CURRENT & ACTIVE: Reliable long-context backup model
  'moonshotai/kimi-k3'
];

const SYSTEM_PROMPT = `You are Compass, an investment research assistant. You will be given web search results alongside the user's question — use them to answer with current, specific information. Don't rely on memory for figures, prices, or recent news; if the search results don't cover something, say so rather than guessing.

Rules:
- Present objective, sourced analysis: what the data shows, what's being reported, relevant context. Never state a directional prediction ("it will go up/down") or a buy/sell/hold call as if it were a fact.
- When you use something from the search results, name the source plainly in your prose (e.g. "according to Reuters..."), and keep exact quotes under 15 words.
- If your answer includes a numeric series worth visualizing (a price trend, a comparison across a few items, historical returns), append ONE fenced block at the very end labeled chartdata containing ONLY valid JSON, nothing else in the block:
\`\`\`chartdata
{"type":"line or bar","title":"short title","labels":["...","..."],"series":[{"name":"series name","values":}]}
\`\`\`
  Only include this block when you have real numbers from the search results — never invent figures.
- End every response that discusses a specific security or fund with one short line reminding the person this is informational, not financial advice.
- Keep responses focused — a few short paragraphs or a tight list, not an essay.`;

async function tavilySearch(query) {
  // 🔥 FIX 1: Safely handle missing or empty environment variable states
  if (!process.env.TAVILY_API_KEY) {
    console.warn("Missing TAVILY_API_KEY environment variable.");
    return [];
  }

  try {
    const res = await fetch('https://tavily.com', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Accept': 'application/json' 
      },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query,
        search_depth: 'basic',
        max_results: 6,
        include_answer: false,
      }),
    });
    
    const bodyText = await res.text();
    
    // 🔥 FIX 2: If the response is blank, do not try to parse it
    if (!bodyText || bodyText.trim() === '') {
      console.warn("Tavily returned an empty string response.");
      return [];
    }

    let data;
    try {
      data = JSON.parse(bodyText);
    } catch (e) {
      // If it's a raw string error page from the server, log it gracefully instead of crashing
      console.error(`Failed to parse Tavily response: ${bodyText}`);
      return [];
    }
    
    if (data.error) {
      console.error("Tavily API Error:", data.error);
      return [];
    }
    
    return data.results || [];
  } catch (err) {
    console.error("Network error during Tavily fetch:", err.message);
    return []; // Return an empty array so the application drops back to the model smoothly
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

    // 1. Search the web safely
    const results = await tavilySearch(lastUserMsg.content);
    const sourcesBlock = results && results.length
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
        if (bodyStr) data = JSON.parse(bodyStr);
      } catch (e) {
        // Fallback for non-JSON string errors
      }

      const isRetiredOrMissing =
        nvidiaRes.status === 410 ||
        nvidiaRes.status === 404 ||
        /no longer available|not found/i.test(bodyStr);

      if (!nvidiaRes.ok || data.error) {
        lastError = `NVIDIA API (${model}) returned ${nvidiaRes.status}: ${bodyStr.slice(0, 300)}`;
        if (isRetiredOrMissing) continue; 
        break; 
      }

      const message = data.choices?.[0]?.message || {};
      text = (message.content || message.reasoning_content || '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .trim();

      if (text) break; 
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
