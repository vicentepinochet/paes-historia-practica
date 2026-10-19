// netlify/functions/chat.js
//
// Backend proxy para el chat de dudas por pregunta. Mantiene la API key de
// Anthropic en el servidor (variable de entorno ANTHROPIC_API_KEY,
// configurada en Netlify > Site settings > Environment variables) para que
// nunca quede expuesta en el código del frontend.
//
// Recibe el contexto de UNA pregunta puntual (texto, alternativas, cuál es
// la correcta y las explicaciones ya escritas) más el mensaje del alumno, y
// responde usando ese contexto, para que el bot no se desvíe del tema.

const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-5-5";
const MAX_HISTORY_TURNS = 6; // pares usuario+asistente que se reenvían como contexto
const MAX_MESSAGE_LEN = 300;
const MAX_TOKENS = 500;

const LETTERS = ["A", "B", "C", "D", "E"];

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Falta configurar ANTHROPIC_API_KEY en Netlify." }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "JSON inválido." }) };
  }

  const { question, options, correct, explanation, optionExplanations, eje, code, message, history } = payload;

  if (!question || !Array.isArray(options) || typeof correct !== "number" || !message) {
    return { statusCode: 400, body: JSON.stringify({ error: "Faltan campos requeridos." }) };
  }

  const userMessage = String(message).slice(0, MAX_MESSAGE_LEN).trim();
  if (!userMessage) {
    return { statusCode: 400, body: JSON.stringify({ error: "Mensaje vacío." }) };
  }

  const safeHistory = Array.isArray(history) ? history.slice(-MAX_HISTORY_TURNS * 2) : [];

  const optionsBlock = options
    .map((opt, i) => {
      const tag = i === correct ? " (CORRECTA)" : "";
      const exp = optionExplanations && optionExplanations[i] ? ` — ${optionExplanations[i]}` : "";
      return `${LETTERS[i] || i}. ${opt}${tag}${exp}`;
    })
    .join("\n");

  const systemPrompt = `Eres un profesor que ayuda a un estudiante chileno a prepararse para la prueba PAES de Historia y Ciencias Sociales.
Estás ayudando SOLO con esta pregunta específica (eje: ${eje || "desconocido"}${code ? `, código ${code}` : ""}):

PREGUNTA:
${question}

ALTERNATIVAS:
${optionsBlock}

EXPLICACIÓN GENERAL:
${explanation || "(no disponible)"}

Responde de forma breve y clara, en español, enfocándote solo en resolver la duda puntual del estudiante sobre esta pregunta (por ejemplo por qué una alternativa es incorrecta, o contexto histórico/económico adicional relacionado). No repitas toda la explicación de memoria si no es necesario. Si el estudiante pregunta algo sin relación con esta pregunta, redirígelo amablemente a enfocarse en ella.`;

  const messages = [
    ...safeHistory.map((m) => ({
      role: m && m.role === "assistant" ? "assistant" : "user",
      content: String((m && m.text) || "").slice(0, 1000),
    })),
    { role: "user", content: userMessage },
  ];

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return {
        statusCode: 502,
        body: JSON.stringify({ error: "Error del proveedor de IA.", detail: errText.slice(0, 500) }),
      };
    }

    const data = await resp.json();
    const reply =
      (Array.isArray(data.content) ? data.content : [])
        .map((block) => block.text || "")
        .join("")
        .trim() || "No pude generar una respuesta.";

    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reply }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Error interno.", detail: String(err).slice(0, 300) }),
    };
  }
};
