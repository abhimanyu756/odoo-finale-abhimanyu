import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { asyncHandler, badRequest } from '../../lib/errors.js';
import { authenticate } from '../../middleware/auth.js';
import { TOOLS, declarations, summariseForModel } from './tools.js';

const router = Router();
router.use(authenticate);

const GEMINI_URL = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

const SYSTEM = `You are Ask HR, the assistant inside PeoplePay360, an HR and payroll system.

Answer questions about employees, attendance, time off and payroll by calling the
tools provided. Never invent figures: if a tool did not return it, say you do not
have it. The user already sees the full result table, so keep your reply to one or
two short sentences that interpret it - do not re-list every row.

Rules:
- Always call a tool for anything factual. Do not answer from memory.
- A tool result includes a "totals" object computed over every row. Use it for
  "how much in total" questions. Never add up the "sample" yourself - it is only
  a few example rows, not the whole result.
- Prefer dimension "employee" when the user asks "who", and a grouping dimension
  when they ask "which department" or "how much".
- If a department, position or leave type name might not exist, call
  list_reference first.
- Today is ${new Date().toISOString().slice(0, 10)}. "This month" and "this year"
  are relative to that.
- You are read-only. If asked to approve, pay, edit or delete anything, explain
  that you can only look things up and point to the screen that does it.
- If a question is outside HR and payroll, say so briefly.`;

const chatSchema = z.object({
  message: z.string().min(1).max(1000),
  // Prior turns, so follow-ups like "and in Sales?" work. Trimmed to keep the
  // request small and the cost predictable.
  // Tolerant of a turn that carries no text: a malformed history entry should
  // cost the model that turn's context, not fail the whole question.
  history: z
    .array(z.object({
      role: z.enum(['user', 'model']),
      text: z.string().max(4000).optional().default(''),
    }))
    .max(10)
    .optional(),
});

// Gemini's free tier returns 429 (rate limit) and 503 (model busy) readily, and
// both are transient. A live demo cannot fail on a hiccup, so each attempt backs
// off briefly and then falls back to a second model before giving up.
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const modelChain = () => {
  const primary = env.gemini.model;
  const fallback = env.gemini.fallbackModel;
  return fallback && fallback !== primary ? [primary, fallback] : [primary];
};

async function callGemini(body) {
  let last = null;

  for (const model of modelChain()) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let res;
      try {
        res = await fetch(`${GEMINI_URL(model)}?key=${env.gemini.apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(20_000),
        });
      } catch (err) {
        last = { status: 0, detail: err.message };
        await sleep(400 * (attempt + 1));
        continue;
      }

      if (res.ok) return res.json();

      const detail = await res.text().catch(() => '');
      last = { status: res.status, detail };

      // A bad request or a bad key will not fix itself; fail immediately.
      if (!RETRYABLE.has(res.status)) break;
      await sleep(400 * (attempt + 1));
    }
  }

  const friendly = RETRYABLE.has(last?.status)
    ? 'The assistant is busy right now — please ask again in a moment.'
    : last?.status === 400
      ? 'The assistant could not understand that request.'
      : 'The assistant is unavailable.';
  throw badRequest(friendly, { status: last?.status, detail: (last?.detail ?? '').slice(0, 200) });
}

router.get('/status', (_req, res) =>
  res.json({
    enabled: env.gemini.enabled,
    model: env.gemini.enabled ? env.gemini.model : null,
    // Shown as starter chips so a demo never begins with an empty box.
    examples: [
      'Which Finance employees had attendance below 80% this month?',
      'Which department took the most leave this year?',
      'Show me salary cost by job position',
      'What time off is still pending approval?',
    ],
  }));

/*
 * One question in, one answer plus the table behind it out.
 *
 * The model chooses a tool and its parameters; the tool runs the same queries
 * the UI runs, scoped to the requesting user. The model only ever sees a small
 * sample of the result, and the client renders the full table from this same
 * response - so the sentence and the numbers cannot disagree.
 */
router.post(
  '/chat',
  asyncHandler(async (req, res) => {
    if (!env.gemini.enabled) {
      return res.json({
        enabled: false,
        answer:
          'The assistant is not configured. Set GEMINI_API_KEY in the server .env '
          + 'to enable it — everything else in the app works without it.',
      });
    }

    const { message, history = [] } = chatSchema.parse(req.body);

    // Gemini expects strictly alternating roles. A dropped turn would otherwise
    // leave two user messages in a row, and the model answers the earlier one.
    const alternating = [];
    for (const h of history) {
      if (!h.text.trim()) continue;
      if (alternating.at(-1)?.role === h.role) alternating.pop();
      alternating.push(h);
    }
    // History must end on a model turn so the new question follows cleanly.
    while (alternating.length && alternating.at(-1).role === 'user') alternating.pop();

    const contents = [
      ...alternating.map((h) => ({ role: h.role, parts: [{ text: h.text }] })),
      { role: 'user', parts: [{ text: message }] },
    ];

    const first = await callGemini({
      contents,
      systemInstruction: { parts: [{ text: SYSTEM }] },
      tools: [{ functionDeclarations: declarations }],
    });

    const parts = first.candidates?.[0]?.content?.parts ?? [];
    const call = parts.find((p) => p.functionCall)?.functionCall;

    // No tool wanted: a greeting, a refusal, or an out-of-scope question.
    if (!call) {
      return res.json({
        enabled: true,
        answer: parts.map((p) => p.text).filter(Boolean).join('\n')
          || "I couldn't work out how to answer that. Try asking about employees, attendance, time off or payroll.",
        toolCall: null,
        result: null,
      });
    }

    const tool = TOOLS[call.name];
    if (!tool) {
      return res.json({
        enabled: true,
        answer: `I tried to use an unknown tool (${call.name}).`,
        toolCall: null,
        result: null,
      });
    }

    const args = call.args ?? {};
    const result = await tool.run(args, req.user);

    // Second turn: the model sees only the shape and a short sample, and writes
    // the caption. The table the user sees comes from `result`, not from this.
    const second = await callGemini({
      contents: [
        ...contents,
        { role: 'model', parts: [{ functionCall: call }] },
        {
          role: 'user',
          parts: [{
            functionResponse: {
              name: call.name,
              response: summariseForModel(result),
            },
          }],
        },
      ],
      systemInstruction: { parts: [{ text: SYSTEM }] },
    });

    const answer = (second.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text)
      .filter(Boolean)
      .join('\n');

    res.json({
      enabled: true,
      answer: answer || `Found ${result.rows.length} result(s).`,
      // Shown under the answer so the user can see exactly what was asked of the
      // system, and open the same query in the dashboard.
      toolCall: { name: call.name, args },
      result,
    });
  }),
);

export default router;
