import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY");
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function getEmbedding(text: string): Promise<number[]> {
  const r = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "openai/text-embedding-3-small", input: text }),
  });
  const d = await r.json();
  if (!d.data?.[0]?.embedding) throw new Error(`Embedding failed: ${JSON.stringify(d)}`);
  return d.data[0].embedding;
}

async function extractMetadata(text: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: `Extract metadata from the user's captured thought. Return JSON with:
- "people": array of people mentioned (empty if none)
- "action_items": array of implied to-dos (empty if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-3 short topic tags (always at least one)
- "type": one of "observation", "task", "idea", "reference", "person_note", "preference"
Only extract what's explicitly there.` },
        { role: "user", content: text },
      ],
    }),
  });
  const d = await r.json();
  try { return JSON.parse(d.choices[0].message.content); }
  catch { return { topics: ["uncategorized"], type: "observation" }; }
}

Deno.serve(async (req: Request): Promise<Response> => {
  // Auth: same access key as open-brain-mcp (x-brain-key header or ?key=)
  const provided = req.headers.get("x-brain-key") || new URL(req.url).searchParams.get("key");
  if (!MCP_ACCESS_KEY || !provided || provided !== MCP_ACCESS_KEY) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  try {
    // Fetch all thoughts with null embeddings
    const { data: thoughts, error: fetchError } = await supabase
      .from("thoughts")
      .select("id, content, metadata")
      .is("embedding", null);

    if (fetchError) throw fetchError;
    if (!thoughts || thoughts.length === 0) {
      return new Response(JSON.stringify({ message: "No thoughts need backfilling.", updated: 0 }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    const results = [];
    for (const thought of thoughts) {
      try {
        const [embedding, metadata] = await Promise.all([
          getEmbedding(thought.content),
          extractMetadata(thought.content),
        ]);

        // Merge new metadata with existing (preserve source, slack_ts, etc.)
        const mergedMetadata = { ...metadata, ...thought.metadata, topics: metadata.topics };

        const { error: updateError } = await supabase
          .from("thoughts")
          .update({ embedding, metadata: mergedMetadata, updated_at: new Date().toISOString() })
          .eq("id", thought.id);

        if (updateError) throw updateError;
        results.push({ id: thought.id, status: "ok" });
      } catch (err) {
        results.push({ id: thought.id, status: "error", error: String(err) });
      }
    }

    const succeeded = results.filter(r => r.status === "ok").length;
    return new Response(JSON.stringify({
      message: `Backfill complete. ${succeeded}/${thoughts.length} thoughts updated.`,
      results
    }), { headers: { "Content-Type": "application/json" } });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
});
