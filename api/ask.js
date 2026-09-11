// /api/ask.js
// Optimized for Vercel Edge Runtime to handle gateway text blocks cleanly.
const { OpenAI } = require('openai');

// Force Vercel to host this on an unrestricted Edge configuration tier
export const config = {
  runtime: 'edge',
};

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

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), { 
      status: 405, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }

  try {
    const { history } = await req.json();
    if (!Array.isArray(history) || history.length === 0) {
      return new Response(JSON.stringify({ error: 'history is required' }), { 
        status: 400, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    const lastUserMsg = [...history].reverse().find(m => m.role === 'user');
    if (!lastUserMsg) {
      return new Response(JSON.stringify({ error: 'No user message found in history' }), { 
        status: 400, 
        headers: { 'Content-Type': 'application/json' } 
      });
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
          const delta = chunk.choices?.[0]?.delta;
          const content = delta?.content || delta?.reasoning_content || '';
          accumulatedText += content;
        }

        finalResponseText = accumulatedText
          .replace(/<think>[\s\S]*?<\/think>/gi, '')
          .trim();

        if (finalResponseText) break; // Exit fallback chain on success
      } catch (err) {
        // 🔥 SAFELY INTERCEPT RAW TEXT ERRS: Intercept code crashes gracefully
        lastError = `Model ${model} failed: ${err.message}`;
        console.warn(`Error captured for ${model}: ${err.message}`);
        continue; // Immediately hop to the backup model option string
      }
    }

    if (!finalResponseText) {
      return new Response(JSON.stringify({ 
        error: lastError || 'All model endpoint handshakes returned unparseable text blocks.' 
      }), { 
        status: 502, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    return new Response(JSON.stringify({ text: finalResponseText }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { 
      status: 500, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }
}
