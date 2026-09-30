/* ============================================================================
   The verse pane: a feeling in, a Bible passage out, from OpenAI with the
   user's own key.
   ----------------------------------------------------------------------------
   nord-dash called OpenAI from the browser with a VITE_ key baked into the
   bundle. Here the Worker makes the call with the key from the vault. Model,
   prompt and JSON schema are nord-dash's, unchanged.

   Nothing is stored and nothing changes, so there is nothing to notify. It is
   a POST because every call costs the user money and gives a different
   answer: nothing should cache or retry it as a read.
   ========================================================================== */

import { FEELING_MAX, type Verse } from "@/domain/panes";
import type { Viewer } from "@/domain/types";
import type { Env } from "../env";
import { badRequest, HttpError, json, readJson } from "../http";
import { openVault } from "../vault";

const OPENAI_MODEL = "gpt-5.4-nano";

const VERSE_SCHEMA = {
  type: "object",
  properties: {
    reference: {
      type: "string",
      description: "Bible reference in Book Chapter:StartVerse-EndVerse format.",
    },
    text: {
      type: "string",
      description: "The full passage text for the selected verses.",
    },
  },
  required: ["reference", "text"],
  additionalProperties: false,
} as const;

const prompt = (feeling: string) => `The user is feeling: "${feeling}".
Find a meaningful bible passage (3-6 verses) that resonates with this feeling and offers deep comfort, wisdom, or guidance.
Focus on passages that encourage reflection and provide substantial spiritual nourishment.
Prefer the New Testament, but use the Old Testament if it is a perfect fit.
Return ONLY a valid JSON object with this exact structure:
{
  "reference": "Book Chapter:StartVerse-EndVerse",
  "text": "The full passage text"
}`;

/**
 * The model's text. `output_text` is a convenience the OpenAI SDKs add; the
 * plain HTTP answer has the text inside `output[].content[]`, so look there
 * when it is missing.
 */
function outputText(data: Record<string, unknown>): string | null {
  if (typeof data.output_text === "string") return data.output_text;
  if (!Array.isArray(data.output)) return null;
  for (const item of data.output as { content?: { type?: string; text?: unknown }[] }[]) {
    for (const part of item.content ?? []) {
      if (part.type === "output_text" && typeof part.text === "string") return part.text;
    }
  }
  return null;
}

/* OpenAI's error bodies can quote part of the key back, so the browser gets
   a line of our own and the log gets the detail. */
function upstreamMessage(status: number): string {
  if (status === 401) return "OpenAI refused the saved key (401). Replace it in settings";
  if (status === 429) return "OpenAI is rate limiting this key or it is out of credit (429)";
  return `OpenAI answered ${status}`;
}

/** POST /api/verse { feeling } */
export async function postVerse(request: Request, env: Env, viewer: Viewer): Promise<Response> {
  const body = await readJson(request);
  if (typeof body.feeling !== "string" || !body.feeling.trim()) {
    throw badRequest("`feeling` must be a non-empty string");
  }
  const feeling = body.feeling.trim();
  if (feeling.length > FEELING_MAX) throw badRequest(`\`feeling\` is longer than ${FEELING_MAX} characters`);

  const key = await openVault(env, viewer.user.id, "openai");
  if (!key) throw badRequest("No OpenAI key saved. Add one in settings, under api keys");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(requestBody(feeling)),
  }).catch((error: unknown) => {
    console.warn("openai unreachable", error);
    throw new HttpError(502, "Could not reach OpenAI");
  });

  if (!response.ok) {
    console.warn("openai error", response.status, (await response.text()).slice(0, 500));
    throw new HttpError(502, upstreamMessage(response.status));
  }

  const text = outputText((await response.json()) as Record<string, unknown>);
  let verse: unknown;
  try {
    verse = text === null ? null : JSON.parse(text);
  } catch {
    verse = null;
  }
  const { reference, text: passage } = (verse ?? {}) as Record<string, unknown>;
  if (typeof reference !== "string" || typeof passage !== "string") {
    throw new HttpError(502, "OpenAI's answer was not a passage");
  }
  return json({ reference, text: passage } satisfies Verse);
}

/** The Responses API request, as nord-dash sent it. */
function requestBody(feeling: string) {
  return {
    model: OPENAI_MODEL,
    input: [
      {
        role: "system",
        content:
          "You are a helpful assistant that provides relevant Bible passages. Always respond with valid JSON only.",
      },
      { role: "user", content: prompt(feeling) },
    ],
    text: { format: { type: "json_schema", name: "bible_quote", schema: VERSE_SCHEMA, strict: true } },
    max_output_tokens: 600,
  };
}
