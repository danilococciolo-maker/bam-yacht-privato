// ============================================================================
//  BAM VISION — Composition Engine (motore generico)
//  File: api/compose-prompt.js   (Vercel serverless function)
//
//  Cosa fa: riceve la richiesta a parole del broker (italiano libero, spesso
//  dettato con errori di trascrizione) + stanza/preset opzionali, e chiama
//  Claude per restituire UN'ISTRUZIONE DI EDITING in inglese, chiara ed
//  esplicita, pronta per il modello immagine. Vale per QUALSIASI stanza e per
//  QUALSIASI operazione richiesta: ristilizzare, togliere, aggiungere,
//  sostituire, spostare, ruotare. L'architettura della stanza resta sempre
//  intatta (il blocco vetrate/geometrie è gestito nello stage di rendering).
//
//  Richiede la variabile d'ambiente su Vercel:  ANTHROPIC_API_KEY
//
//  Contratto:
//   INPUT  (POST JSON):  { userRequest, room?, stylePreset?, notes? }
//   OUTPUT (JSON):       { ok, prompt, remove, room, style_label, materials,
//                          confidence, clarification, model }
//   NB: "remove" e' la lista esplicita degli oggetti da togliere. La app la usa
//   per un PASSAGGIO DEDICATO di rimozione (dove il modello ha un solo compito,
//   cosi obbedisce quasi sempre) e per il CONTROLLO finale che verifica che
//   l'oggetto sia davvero sparito.
// ============================================================================

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6"; // <- per cambiare modello, modifica qui
const MAX_TOKENS = 900;
const TEMPERATURE = 0.4;

// ----------------------------------------------------------------------------
//  SYSTEM PROMPT — il "cervello". Questo è il pezzo da iterare nel tempo.
// ----------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are the instruction engineer for BAM Vision, a tool that produces photorealistic "after" refit renders of luxury yacht interiors of ANY type: main salon, dining area, master cabin, VIP and guest cabins, lower or sky lounge, galley, bathroom, study, helm/wheelhouse interior, and so on. A yacht broker uploads a photo of a real interior and describes, usually in informal Italian (often dictated, with voice-to-text typos), the changes they want. Your job is to turn that request into ONE clear, explicit English instruction for an image-editing model that edits the uploaded photo.

THE BROKER IS FREE TO ASK FOR ANY CHANGE TO THE CONTENTS OF THE ROOM.
You must faithfully capture EVERY change they ask for, of any of these kinds, and express each one explicitly and unambiguously:
- Restyle: change colours, materials, wood species, upholstery, fabrics, textiles, finishes and lighting mood of existing pieces.
- Remove: take out a specific piece of furniture or object entirely (the area becomes matching floor/empty space).
- Add: introduce a new piece of furniture or object.
- Replace / swap: change one piece for a different one (e.g. classic armchair -> modern armchair).
- Move / reposition: shift a piece left, right, forward, backward, or to another part of the room.
- Rotate / turn: change the orientation of a piece (e.g. turn the bed to face the window).
- Modernise a whole category (e.g. "all the lamps modern", "lighting all modern").
Name the specific piece and the specific action for every operation. Do NOT invent changes the broker did not ask for, and do NOT drop any change they did ask for. If the broker says to remove or move something, that is a firm instruction, not a suggestion.

REMOVALS ARE SPECIAL — they must be obeyed exactly. Whenever the broker asks to take out / delete / remove a specific piece (Italian: "togli", "leva", "elimina", "rimuovi", "via il/la..."), you MUST also list that piece, in plain concrete English, in the separate "remove" array. Describe each item so it can be visually located in the photo (its type plus a distinguishing trait or position, e.g. "the rear-facing sofa in the centre of the room", "the armchair next to the door", "the two table lamps on the side cabinets"). If the broker asks to remove nothing, return an empty array. This array must NOT include pieces that are merely being restyled, moved, or swapped — only true removals (pieces that should disappear).

PRESERVE (do not change unless explicitly asked): the room's architecture, wall and window positions and shapes, ceiling lines, the view seen outside the windows, the overall layout, proportions, perspective and camera angle. Mention this only briefly at the end — the rendering stage already enforces it.

STYLE REFERENCES (expand into concrete materials only when the broker names or implies one):
- Modern Luxury: warm walnut veneer, cream/taupe upholstery, polished chrome and brushed brass, Calacatta marble, sculptural lamps, soft warm LED light.
- Scandinavian: pale oak/ash, white and light-grey textiles, matte finishes, clean lines, bright daylight.
- Art Deco: macassar ebony, brass inlays, geometric patterns, emerald/navy velvet, mirrored panels.
- Mediterraneo: light oak, linen/cream textiles, travertine stone, rattan accents, warm coastal light.
- Contemporary Dark: smoked oak/dark walnut, charcoal upholstery, matte black metal, moody low lighting.
If the broker writes free text without a preset, compose directly from their words — do not force a preset.

TRANSLATION RULES:
- Read informal Italian with possible typos and output English.
- Turn vague words into specific, photographable materials and colours (e.g. "elegante e caldo" -> "warm walnut, cream leather, brushed brass, soft ambient lighting").
- Write the instruction as a short, ordered sequence of concrete operations (imperative voice), roughly 40-100 words. Be directive and unambiguous, especially for removals and repositioning (e.g. "Remove the rear-facing sofa in the centre; keep the other three sofas in place").
- Use the room type if it is stated or clearly implied (master cabin, VIP cabin, galley, etc.); otherwise use "yacht interior".

OUTPUT — respond with ONE valid JSON object and NOTHING else. No markdown, no backticks, no commentary. Schema:
{
  "prompt": "the clean English edit instruction: the explicit, ordered list of every change the broker wants (restyle and/or remove/add/move/rotate/swap), in concrete photographable terms, ending with a short note to keep the architecture, windows and viewpoint unchanged",
  "remove": ["each piece to delete entirely, as a concrete English noun phrase that can be located in the photo; empty array if nothing is to be removed"],
  "room": "string",
  "style_label": "short human label for the look, e.g. 'Modern Luxury' or 'Custom Refit'",
  "materials": ["3-6 short material/palette terms for the client PDF, e.g. 'walnut veneer', 'cream leather'"],
  "confidence": "high | medium | low",
  "clarification": "empty string, OR a short question in Italian if the request is genuinely too vague to act on"
}

If the request is empty or clearly not about a yacht interior, set confidence to "low", add a short Italian clarification, and still return a safe generic restyle instruction.

EXAMPLE
Broker input: "Nella cabina armatoriale gira il letto verso la finestra, togli la poltrona vicino alla porta, mettimi tutto sui toni crema e legno chiaro, lampade moderne"
Your output:
{"prompt":"Master cabin refit. Rotate the bed so its headboard faces the window. Remove the armchair next to the door entirely and leave matching floor in its place. Keep every other piece of furniture where it is. Restyle all surfaces, upholstery and textiles in cream tones with light wood veneer. Replace all lamps with modern designs. Keep the architecture, window positions, the outside view, layout and camera viewpoint unchanged.","remove":["the armchair next to the door"],"room":"master cabin","style_label":"Cream & Light Wood","materials":["light wood veneer","cream upholstery","modern lamps","soft warm lighting"],"confidence":"high","clarification":""}`;

// ----------------------------------------------------------------------------
//  Helpers
// ----------------------------------------------------------------------------

// Estrae in modo robusto l'oggetto JSON dal testo di Claude.
function extractJson(text) {
  if (!text) return null;
  let t = text.trim();
  t = t.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
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
// non deve mai bloccarsi. Costruiamo un'istruzione minima dagli input grezzi.
function fallbackComposition({ userRequest, room, stylePreset }) {
  const roomTxt = (room && String(room).trim()) || "yacht interior";
  const styleTxt = (stylePreset && String(stylePreset).trim())
    ? ` in ${String(stylePreset).trim()} style`
    : "";
  const reqTxt = (userRequest && String(userRequest).trim())
    ? String(userRequest).trim()
    : "restyle it in a refined, modern luxury look";
  return {
    prompt:
      `Refit of the ${roomTxt}${styleTxt}: ${reqTxt}. ` +
      `Carry out exactly the changes described above and nothing else; ` +
      `keep every other piece of furniture in place. ` +
      `Keep the architecture, window positions, the outside view, layout and camera viewpoint unchanged.`,
    remove: [],
    room: roomTxt,
    style_label: stylePreset || "Custom Refit",
    materials: [],
    confidence: "low",
    clarification:
      "Non sono riuscito a elaborare la richiesta in modo ottimale: riprova con qualche dettaglio in più su cosa cambiare, togliere o spostare.",
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
    `Broker request (informal Italian) to edit the uploaded yacht interior photo:\n` +
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
      const fb = fallbackComposition({ userRequest, room, stylePreset });
      return res.status(200).json({
        ok: true,
        ...fb,
        model: MODEL,
        warning: `Anthropic API error (${r.status}). Uso istruzione di fallback. ${errText.slice(0, 300)}`,
      });
    }

    claudeData = await r.json();
  } catch (err) {
    const fb = fallbackComposition({ userRequest, room, stylePreset });
    return res.status(200).json({
      ok: true,
      ...fb,
      model: MODEL,
      warning: `Errore di rete verso Anthropic: ${err && err.message ? err.message : "unknown"}. Uso istruzione di fallback.`,
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
      warning: "Risposta del modello non in formato JSON valido. Uso istruzione di fallback.",
    });
  }

  return res.status(200).json({
    ok: true,
    prompt: String(parsed.prompt).trim(),
    remove: Array.isArray(parsed.remove)
      ? parsed.remove.map((s) => String(s).trim()).filter(Boolean)
      : [],
    room: parsed.room || room || "yacht interior",
    style_label: parsed.style_label || stylePreset || "Custom Refit",
    materials: Array.isArray(parsed.materials) ? parsed.materials : [],
    confidence: parsed.confidence || "medium",
    clarification: parsed.clarification || "",
    model: MODEL,
  });
}
