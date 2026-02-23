const { google } = require("googleapis");
const { v4: uuidv4 } = require("uuid");

// ===== Google Auth =====
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

const SHEET_ID = process.env.SHEET_ID;
const CALENDAR_ID = process.env.CALENDAR_ID || "primary";

// ===== Helpers =====
function parseCommand(text) {
  // Ej: AGENDAR|Julia|2026-02-25|16:00|PARTICULAR
  const parts = text.split("|").map((s) => s.trim());
  const cmd = (parts[0] || "").toUpperCase();
  return { cmd, parts };
}

async function appendTurno(row) {
  // row = array matching TURNOS columns order
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "TURNOS!A:Z",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
}

async function findTurno(paciente, fecha) {
  // Búsqueda simple: trae TURNOS y filtra (para pocas filas va joya)
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "TURNOS!A:Z",
  });

  const values = resp.data.values || [];
  if (values.length < 2) return null;

  const headers = values[0];
  const rows = values.slice(1);

  const idxPaciente = headers.indexOf("paciente");
  const idxFecha = headers.indexOf("fecha");
  const idxId = headers.indexOf("id");
  const idxPago = headers.indexOf("pago");
  const idxEstado = headers.indexOf("estado");
  const idxEventId = headers.indexOf("calendar_event_id");

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (
      (r[idxPaciente] || "").toLowerCase() === paciente.toLowerCase() &&
      (r[idxFecha] || "") === fecha &&
      (r[idxEstado] || "ACTIVO") !== "CANCELADO"
    ) {
      return {
        rowNumber: i + 2, // + header row
        id: r[idxId],
        pago: r[idxPago],
        estado: r[idxEstado],
        calendarEventId: r[idxEventId],
        headers,
      };
    }
  }
  return null;
}

async function updateTurnoCell(rowNumber, colLetter, value) {
  // rowNumber: sheet row index (1-based)
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `TURNOS!${colLetter}${rowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[value]] },
  });
}

function colLetterFromHeader(headers, headerName) {
  const idx = headers.indexOf(headerName);
  if (idx < 0) throw new Error(`No existe columna ${headerName}`);
  // idx 0 => A
  return String.fromCharCode("A".charCodeAt(0) + idx);
}

async function createCalendarEvent({ paciente, fecha, hora, tipo, pago }) {
  // fecha: YYYY-MM-DD, hora: HH:MM (asumimos hora local del calendar)
  const start = `${fecha}T${hora}:00`;
  // duración 50 min (cambiable)
  const endDate = new Date(`${fecha}T${hora}:00`);
  endDate.setMinutes(endDate.getMinutes() + 50);
  const end = endDate.toISOString().slice(0, 19);

  const summary = `${paciente} – Psicoterapia`;
  const description = `Tipo: ${tipo}\nPago: ${pago}`;

  const ev = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    requestBody: {
      summary,
      description,
      start: { dateTime: start },
      end: { dateTime: end },
    },
  });

  return ev.data.id;
}

async function patchCalendarEvent(eventId, fields) {
  await calendar.events.patch({
    calendarId: CALENDAR_ID,
    eventId,
    requestBody: fields,
  });
}

// ===== En tu webhook, cuando tengas text =====
// Llamá a handleTextCommand(text) y que devuelva una respuesta

async function handleTextCommand(text) {
  const { cmd, parts } = parseCommand(text);

  if (cmd === "AGENDAR") {
    const paciente = parts[1];
    const fecha = parts[2];
    const hora = parts[3];
    const tipo = (parts[4] || "PARTICULAR").toUpperCase();
    if (!paciente || !fecha || !hora) {
      return "Formato: AGENDAR|Nombre|YYYY-MM-DD|HH:MM|PARTICULAR/OS";
    }

    const id = uuidv4();
    const pago = "PENDIENTE";
    const estado = "ACTIVO";
    const createdAt = new Date().toISOString();

    const calendarEventId = await createCalendarEvent({ paciente, fecha, hora, tipo, pago });

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

    return `✅ Agendado\n${paciente}\n${fecha} ${hora}\nTipo: ${tipo}\nPago: ${pago}`;
  }

  if (cmd === "PAGO") {
    // PAGO|Julia|2026-02-25|PAGO
    const paciente = parts[1];
    const fecha = parts[2];
    const pago = (parts[3] || "").toUpperCase();
    if (!paciente || !fecha || !pago) {
      return "Formato: PAGO|Nombre|YYYY-MM-DD|PAGO/DEBE/PENDIENTE";
    }

    const turno = await findTurno(paciente, fecha);
    if (!turno) return `No encontré turno activo para ${paciente} en ${fecha}.`;

    // actualizar Sheets
    const colPago = colLetterFromHeader(turno.headers, "pago");
    await updateTurnoCell(turno.rowNumber, colPago, pago);

    // actualizar Calendar
    if (turno.calendarEventId) {
      await patchCalendarEvent(turno.calendarEventId, {
        description: `Pago: ${pago}\n(Actualizado por bot)`,
      });
    }

    return `💰 Pago actualizado: ${paciente} (${fecha}) → ${pago}`;
  }

  return "Comandos:\nAGENDAR|Nombre|YYYY-MM-DD|HH:MM|PARTICULAR/OS\nPAGO|Nombre|YYYY-MM-DD|PAGO/DEBE/PENDIENTE";
}