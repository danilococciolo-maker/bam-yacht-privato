// ============================================================================
//  BAM VISION — Composition Engine
//  File: api/compose-prompt.js   (Vercel serverless function)
//
//  Cosa fa: riceve la richiesta a parole del broker (italiano libero + preset
//  opzionale) e chiama Claude per restituire un PROMPT TECNICO in inglese,
//  pronto per Flux, con il GEOMETRY LOCK sempre applicato (cambia solo stile,
//  materiali, arredi, luce — MAI l'architettura della stanza).
//
//  Richiede la variabile d'ambiente su Vercel:  ANTHROPIC_API_KEY
//  (Settings -> Environment Variables del progetto).
//
//  Contratto:
//   INPUT  (POST JSON):  { userRequest, room?, stylePreset?, notes? }
//   OUTPUT (JSON):       { ok, prompt, negative_prompt, room, style_label,
//                          materials, confidence, clarification, model }
// ============================================================================

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6"; // <- per cambiare modello, modifica qui
const MAX_TOKENS = 800;
const TEMPERATURE = 0.4;
const TRIGGER = "bamyacht_interior";

// ----------------------------------------------------------------------------
//  SYSTEM PROMPT — il "cervello". Questo è il pezzo da iterare nel tempo.
// ----------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are the prompt engineer for BAM Vision, a tool that produces photorealistic "after" refit renders of luxury Italian yacht interiors. A yacht broker uploads a photo of a real interior (the "before") and describes, often in Italian and informally, how they want it restyled. Your job is to translate that request into ONE precise English technical prompt for a Flux image model, used as an image-to-image restyle of the uploaded photo.

THE SINGLE MOST IMPORTANT RULE — GEOMETRY LOCK:
This is a refit, not a new room. You must ALWAYS preserve the existing architecture: wall and window positions, window shapes, ceiling lines and height, room layout, proportions, perspective and camera angle. You only change: finishes, materials, wood species, upholstery, textiles, colours, furniture style, decor objects, and lighting mood. Never add or remove rooms, never move or resize windows, never change the viewpoint. Every prompt you output must end with an explicit geometry-lock clause.

TRIGGER WORD:
Every prompt must begin with the exact token "${TRIGGER}," (lowercase, followed by a comma). It activates the BAM yacht-interior LoRA.

STYLE PRESETS (expand these into concrete materials when the broker selects or implies one):
- "Modern Luxury": warm walnut veneer, cream and taupe upholstery, polished chrome and brushed brass accents, Calacatta marble, sculptural lamps, soft warm LED lighting.
- "Scandinavian": pale oak and ash, white and light-grey textiles, matte finishes, clean minimal lines, bright airy natural daylight.
- "Art Deco": dark macassar ebony, brass inlays, geometric patterns, emerald or navy velvet, mirrored panels, statement lighting.
- "Mediterraneo": light oak, linen and cream textiles, natural travertine stone, woven rattan accents, relaxed coastal feel, warm sunlight.
- "Contemporary Dark": smoked oak and dark walnut, charcoal and anthracite upholstery, matte black metal, dramatic low moody lighting.
If the broker writes free text without a preset, compose directly from their description; do not force a preset.

TRANSLATION RULES:
- Read Italian (with possible voice-to-text typos) and output English.
- Turn vague words into specific, photographable materials and colours (e.g. "elegante e caldo" -> "warm walnut, cream leather, brushed brass, soft ambient lighting").
- Keep the prompt concise and directive (roughly 40-70 words in the description part), photorealistic, editorial yacht aesthetic.
- If a room type is given or clearly implied, name it (main salon, master cabin, VIP cabin, guest cabin, galley, bathroom, dining area). Otherwise use "yacht interior".

ALWAYS AVOID (put in negative_prompt): people, text, watermark, logo, brand names, deformed or distorted furniture, warped or relocated windows, extra rooms, heavy clutter, cartoon, illustration, lowres, oversaturated.

OUTPUT FORMAT — respond with ONE valid JSON object and NOTHING else. No markdown, no backticks, no commentary. Schema:
{
  "prompt": "string, starts with '${TRIGGER},', includes the style/materials/furniture/lighting AND ends with the geometry-lock clause",
  "negative_prompt": "string",
  "room": "string",
  "style_label": "short human label, e.g. 'Modern Luxury'",
  "materials": ["3-6 short material/palette terms, for the client PDF, e.g. 'walnut veneer', 'cream leather', 'Calacatta marble'"],
  "confidence": "high | medium | low",
  "clarification": "empty string, OR a short question in Italian if the request is too vague to compose well"
}

If the request is empty or off-topic (not a yacht-interior refit), set confidence to "low", put a brief Italian clarification, and still return a safe generic prompt.

EXAMPLE
Broker input: "Salone, lo voglio moderno e luxury, toni caldi, divani crema, mi raccomando lascia le finestre come sono"
Your output:
{"prompt":"${TRIGGER}, luxury yacht main salon restyled in modern luxury, warm walnut veneer panelling, cream leather sofas, taupe accents, brushed brass details, Calacatta marble surfaces, soft warm ambient lighting, photorealistic editorial interior, preserving the existing architecture, wall and window positions, window shapes, ceiling lines, room layout, proportions, perspective and camera angle unchanged","negative_prompt":"people, text, watermark, logo, brand names, deformed furniture, distorted or relocated windows, extra rooms, clutter, cartoon, illustration, lowres, oversaturated","room":"main salon","style_label":"Modern Luxury","materials":["walnut veneer","cream leather","brushed brass","Calacatta marble","warm ambient lighting"],"confidence":"high","clarification":""}`;

// ----------------------------------------------------------------------------
//  Helpers
// ----------------------------------------------------------------------------

// Estrae in modo robusto l'oggetto JSON dal testo di Claude.
function extractJson(text) {
  if (!text) return null;
  let t = text.trim();
  // togli eventuali fence ```json ... ```
  t = t.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  // se c'è testo intorno, prendi dal primo { all'ultimo }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    t = t.slice(start, end + 1);
  }
  try {
    return JSON.parse(t);
  } catch (e) {
    return null;
  }
}

// Prompt di emergenza: se Claude fallisce o non torna JSON valido, la pipeline
// non deve mai bloccarsi. Costruiamo un prompt minimo dagli input grezzi.
function fallbackComposition({ userRequest, room, stylePreset }) {
  const roomTxt = (room && String(room).trim()) || "yacht interior";
  const styleTxt = (stylePreset && String(stylePreset).trim())
    ? `, ${String(stylePreset).trim()} style`
    : "";
  const reqTxt = (userRequest && String(userRequest).trim())
    ? `, ${String(userRequest).trim()}`
    : "";
  return {
    prompt:
      `${TRIGGER}, luxury yacht ${roomTxt} restyled${styleTxt}${reqTxt}, ` +
      `photorealistic editorial interior, preserving the existing architecture, ` +
      `wall and window positions, window shapes, ceiling lines, room layout, ` +
      `proportions, perspective and camera angle unchanged`,
    negative_prompt:
      "people, text, watermark, logo, brand names, deformed furniture, " +
      "distorted or relocated windows, extra rooms, clutter, cartoon, illustration, lowres, oversaturated",
    room: roomTxt,
    style_label: stylePreset || "Custom",
    materials: [],
    confidence: "low",
    clarification:
      "Non sono riuscito a elaborare la richiesta in modo ottimale: riprova con qualche dettaglio in più su stile, materiali e colori.",
  };
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ----------------------------------------------------------------------------
//  Handler
// ----------------------------------------------------------------------------
export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed. Use POST." });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      ok: false,
      error: "ANTHROPIC_API_KEY mancante. Aggiungila nelle Environment Variables del progetto su Vercel.",
    });
  }

  // Parse del body (può arrivare già oggetto o come stringa)
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  const userRequest = (body.userRequest || "").toString().trim();
  const room = (body.room || "").toString().trim();
  const stylePreset = (body.stylePreset || "").toString().trim();
  const notes = (body.notes || "").toString().trim();

  if (!userRequest && !stylePreset) {
    return res.status(400).json({
      ok: false,
      error: "Serve almeno una descrizione (userRequest) o un preset di stile (stylePreset).",
    });
  }

  // Costruzione del messaggio per Claude
  const userMessage =
    `Broker request (Italian, restyle the uploaded yacht interior photo):\n` +
    (room ? `Room: ${room}\n` : "") +
    (stylePreset ? `Selected style preset: ${stylePreset}\n` : "") +
    (userRequest ? `Description: ${userRequest}\n` : "") +
    (notes ? `Extra notes: ${notes}\n` : "") +
    `\nReturn the single JSON object as instructed.`;

  // Chiamata all'API Claude
  let claudeData;
  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        temperature: TEMPERATURE,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      // Anthropic ha risposto con errore: torniamo il fallback (pipeline mai bloccata)
      const fb = fallbackComposition({ userRequest, room, stylePreset });
      return res.status(200).json({
        ok: true,
        ...fb,
        model: MODEL,
        warning: `Anthropic API error (${r.status}). Uso prompt di fallback. ${errText.slice(0, 300)}`,
      });
    }

    claudeData = await r.json();
  } catch (err) {
    const fb = fallbackComposition({ userRequest, room, stylePreset });
    return res.status(200).json({
      ok: true,
      ...fb,
      model: MODEL,
      warning: `Errore di rete verso Anthropic: ${err && err.message ? err.message : "unknown"}. Uso prompt di fallback.`,
    });
  }

  // Estrazione del testo e parsing del JSON
  const text = Array.isArray(claudeData.content)
    ? claudeData.content.filter((b) => b.type === "text").map((b) => b.text).join("")
    : "";
  const parsed = extractJson(text);

  if (!parsed || !parsed.prompt) {
    const fb = fallbackComposition({ userRequest, room, stylePreset });
    return res.status(200).json({
      ok: true,
      ...fb,
      model: MODEL,
      warning: "Risposta del modello non in formato JSON valido. Uso prompt di fallback.",
    });
  }

  // Garanzie minime sull'output
  let prompt = String(parsed.prompt).trim();
  if (!prompt.toLowerCase().startsWith(TRIGGER)) {
    prompt = `${TRIGGER}, ${prompt}`;
  }

  return res.status(200).json({
    ok: true,
    prompt,
    negative_prompt:
      parsed.negative_prompt ||
      "people, text, watermark, logo, deformed furniture, distorted windows, extra rooms, clutter, cartoon, lowres",
    room: parsed.room || room || "yacht interior",
    style_label: parsed.style_label || stylePreset || "Custom",
    materials: Array.isArray(parsed.materials) ? parsed.materials : [],
    confidence: parsed.confidence || "medium",
    clarification: parsed.clarification || "",
    model: MODEL,
  });
}
