/***********************
 * IMPORTS
 ***********************/
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const { google } = require("googleapis");
const { v4: uuidv4 } = require("uuid");

/***********************
 * APP SETUP
 ***********************/
const app = express();
app.use(bodyParser.json());

/***********************
 * ENV VARS
 ***********************/
const VERIFY_TOKEN = "psi_token_123";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.PHONE_ID;
const ALLOWED_TO = process.env.ALLOWED_TO; // test recipient
const SHEET_ID = process.env.SHEET_ID;
const CALENDAR_ID = process.env.CALENDAR_ID || "primary";

/***********************
 * GOOGLE AUTH
 ***********************/
function getGoogleAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Falta GOOGLE_SERVICE_ACCOUNT_JSON");

  const creds = JSON.parse(raw);

  return new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/calendar",
    ],
  });
}

const auth = getGoogleAuth();
const sheets = google.sheets({ version: "v4", auth });
const calendar = google.calendar({ version: "v3", auth });

/***********************
 * WHATSAPP SEND
 ***********************/
async function sendMessage(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v22.0/${PHONE_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        text: { body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err) {
    console.error("Error enviando WhatsApp:", err?.response?.data || err);
  }
}

/***********************
 * GOOGLE HELPERS
 ***********************/
async function appendTurno(row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "TURNOS!A:Z",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
}

async function createCalendarEvent({ paciente, fecha, hora, tipo, pago }) {
  const start = `${fecha}T${hora}:00`;
  const endDate = new Date(`${fecha}T${hora}:00`);
  endDate.setMinutes(endDate.getMinutes() + 50);
  const end = endDate.toISOString().slice(0, 19);

  const ev = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    requestBody: {
      summary: `${paciente} – Psicoterapia`,
      description: `Tipo: ${tipo}\nPago: ${pago}`,
      start: { dateTime: start },
      end: { dateTime: end },
    },
  });

  return ev.data.id;
}

/***********************
 * COMMAND HANDLER
 ***********************/
async function handleTextCommand(text) {
  const parts = text.split("|").map((p) => p.trim());
  const cmd = (parts[0] || "").toUpperCase();

  // AGENDAR|Julia|2026-02-25|16:00|PARTICULAR
  if (cmd === "AGENDAR") {
    const paciente = parts[1];
    const fecha = parts[2];
    const hora = parts[3];
    const tipo = (parts[4] || "PARTICULAR").toUpperCase();

    if (!paciente || !fecha || !hora) {
      return "Formato: AGENDAR|Nombre|YYYY-MM-DD|HH:MM|PARTICULAR/OS";
    }

    const pago = "PENDIENTE";
    const estado = "ACTIVO";
    const id = uuidv4();
    const createdAt = new Date().toISOString();

    const calendarEventId = await createCalendarEvent({
      paciente,
      fecha,
      hora,
      tipo,
      pago,
    });

    await appendTurno([
      id,
      paciente,
      fecha,
      hora,
      tipo,
      pago,
      estado,
      calendarEventId,
      "",
      createdAt,
    ]);

    return `✅ Agendado\n${paciente}\n${fecha} ${hora}\nTipo: ${tipo}`;
  }

  return (
    "Comandos disponibles:\n" +
    "AGENDAR|Nombre|YYYY-MM-DD|HH:MM|PARTICULAR/OS\n"
  );
}

/***********************
 * WEBHOOK VERIFY
 ***********************/
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

/***********************
 * WEBHOOK RECEIVE
 ***********************/
app.post("/webhook", (req, res) => {
  res.sendStatus(200);

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    if (!msg) return;

    const text = msg.text?.body || "";
    console.log("TEXTO:", text);

    (async () => {
      try {
        const reply = await handleTextCommand(text);
        const to = ALLOWED_TO || msg.from;
        await sendMessage(to, reply);
      } catch (e) {
        console.error("ERROR CMD:", e);
      }
    })();
  } catch (e) {
    console.error("ERROR WEBHOOK:", e);
  }
});

/***********************
 * SERVER
 ***********************/
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () =>
  console.log("Bot activo en puerto", PORT)
);