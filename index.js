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
app.post("/webhook", async (req, res) => {
  console.log("WEBHOOK BODY:", JSON.stringify(req.body, null, 2));

  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;

    if (messages && messages.length > 0) {
      const msg = messages[0];
      const from = msg.from;

      let text = "";

      if (msg.type === "text") {
        text = msg.text.body;
      } else {
        text = "[mensaje no-texto]";
      }

      await sendMessage(from, "Recibido: " + text);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("ERROR WEBHOOK:", err);
    res.sendStatus(200);
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
sendMessage("54111564512799", "BOT REINICIADO");
app.listen(PORT, "0.0.0.0", () => console.log("Bot activo en puerto", PORT));