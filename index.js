const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

const app = express();
app.use(bodyParser.json());

const VERIFY_TOKEN = "psi_token_123";
const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.PHONE_ID;

// Logs básicos (te ayudan a ver si entra tráfico)
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Rutas de prueba/health
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/health", (_req, res) => res.status(200).send("healthy"));

// Webhook verificación
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Recibir mensajes
app.post("/webhook", (req, res) => {
  // 1) Siempre contestar rápido a Meta
  res.sendStatus(200);

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;

    const hasMessages = Array.isArray(value?.messages) && value.messages.length > 0;
    const hasStatuses = Array.isArray(value?.statuses) && value.statuses.length > 0;

    console.log("Webhook: hasMessages=", hasMessages, "hasStatuses=", hasStatuses);

    // 2) Si es solo status (sent/read), no respondemos por WhatsApp
    if (!hasMessages) return;

    const msg = value.messages[0];
    //const from = msg.from;
    const to = "54111564512799"; // tu test recipient que ya funciona

    // Puede venir text u otros tipos
    const text = msg.text?.body ?? `(tipo=${msg.type})`;

    // 3) Enviar respuesta (no await para no trabar)
    sendMessage(to, "Recibido: " + text).catch((err) => {
      console.error("Error enviando respuesta:", err?.response?.data || err);
    });
  } catch (err) {
    console.error("Error procesando webhook:", err);
  }
});

// Enviar mensaje
async function sendMessage(to, text) {
  if (!TOKEN || !PHONE_ID) {
    console.error("Faltan env vars: WHATSAPP_TOKEN o PHONE_ID");
    return;
  }

  await axios.post(
    `https://graph.facebook.com/v19.0/${PHONE_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      text: { body: text },
    },
    {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    }
  );
}

// Capturar errores que a veces tumbarían el proceso
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));

const PORT = process.env.PORT || 3000;
// bind explícito a 0.0.0.0 (Railway/containers lo agradecen)
//sendMessage("54111564512799", "BOT REINICIADO");
app.listen(PORT, "0.0.0.0", () => console.log("Bot activo en puerto", PORT));