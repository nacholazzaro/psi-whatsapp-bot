/***********************
 * PSI BOT - WhatsApp + Google Sheets + Google Calendar
 * Más humano + features: agendar, listar, cancelar, reprogramar,
 * pago, nota, buscar, estado, validaciones, dedupe, seguridad.
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
app.use(bodyParser.json({ limit: "2mb" }));

/***********************
 * ENV VARS
 ***********************/
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "psi_token_123";

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.PHONE_ID;

const SHEET_ID = process.env.SHEET_ID;
const CALENDAR_ID = process.env.CALENDAR_ID || "primary";

const TIMEZONE = process.env.TZ_NAME || "America/Argentina/Buenos_Aires";

// Si seteás ALLOWED_TO, todas las respuestas van a ese nro (modo test).
// Si no, responde al remitente real.
const ALLOWED_TO = process.env.ALLOWED_TO;

// Opcional: whitelist de números que pueden escribirle al bot (separados por coma).
// Ej: "54911xxxxxxx,54911yyyyyyy"
const ALLOWED_FROM = (process.env.ALLOWED_FROM || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Hoja/rango
const SHEET_NAME = process.env.SHEET_NAME || "TURNOS";
const SHEET_RANGE_ALL = `${SHEET_NAME}!A:Z`;

/***********************
 * BASIC GUARDS
 ***********************/
function assertEnv() {
  const missing = [];
  if (!WHATSAPP_TOKEN) missing.push("WHATSAPP_TOKEN");
  if (!PHONE_ID) missing.push("PHONE_ID");
  if (!SHEET_ID) missing.push("SHEET_ID");
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    missing.push("GOOGLE_SERVICE_ACCOUNT_JSON");

  if (missing.length) {
    console.error("Faltan ENV:", missing.join(", "));
    // No tiramos error para que el container levante igual,
    // pero el bot no va a poder operar.
  }
}
assertEnv();

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
  console.log("[SEND] to:", to);
  try {
    const r = await axios.post(
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
        timeout: 15000,
      }
    );
    console.log("[SEND] ok status:", r.status);
  } catch (err) {
    console.error("[SEND] error:", err?.response?.status, err?.response?.data || err.message || err);
  }
}

/***********************
 * UTILS
 ***********************/
function nowISO() {
  return new Date().toISOString();
}

function normalizeSpaces(s) {
  return (s || "").toString().replace(/\s+/g, " ").trim();
}

function upperNoAccents(s) {
  return normalizeSpaces(s)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toUpperCase();
}

function isValidISODate(yyyy_mm_dd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(yyyy_mm_dd)) return false;
  const [y, m, d] = yyyy_mm_dd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

function isValidTimeHHMM(hhmm) {
  if (!/^\d{2}:\d{2}$/.test(hhmm)) return false;
  const [h, m] = hhmm.split(":").map(Number);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function addMinutesToHHMM(hhmm, minutesToAdd) {
  const [h, m] = hhmm.split(":").map(Number);
  const total = h * 60 + m + minutesToAdd;
  const nh = Math.floor((total % (24 * 60)) / 60);
  const nm = total % 60;
  return `${pad2(nh)}:${pad2(nm)}`;
}

function parseDateFlexible(raw) {
  // Acepta: YYYY-MM-DD, DD/MM, DD/MM/YYYY, DD-MM, DD-MM-YYYY
  const s = normalizeSpaces(raw);
  if (!s) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  const m = s.match(/^(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{4}))?$/);
  if (m) {
    const dd = Number(m[1]);
    const mm = Number(m[2]);
    const yyyy = m[3] ? Number(m[3]) : new Date().getFullYear();
    const iso = `${yyyy}-${pad2(mm)}-${pad2(dd)}`;
    return isValidISODate(iso) ? iso : null;
  }

  return null;
}

function parseTimeFlexible(raw) {
  // Acepta: 16, 16:00, 9, 9:30
  const s = normalizeSpaces(raw);
  if (!s) return null;

  if (/^\d{1,2}$/.test(s)) {
    const h = Number(s);
    if (h < 0 || h > 23) return null;
    return `${pad2(h)}:00`;
  }

  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
    return `${pad2(hh)}:${pad2(mm)}`;
  }

  return null;
}

function friendlyHelp() {
  return (
    "👋 Hola! Soy tu bot de agenda.\n\n" +
    "Podés escribirme de dos formas:\n" +
    "1) *Comandos*\n" +
    "• AGENDAR|Nombre|YYYY-MM-DD|HH:MM|PARTICULAR/OS\n" +
    "• LISTAR|YYYY-MM-DD\n" +
    "• BUSCAR|Nombre\n" +
    "• CANCELAR|<id>\n" +
    "• REPROGRAMAR|<id>|YYYY-MM-DD|HH:MM\n" +
    "• PAGADO|<id>|(opcional: detalle)\n" +
    "• NOTA|<id>|tu nota\n" +
    "• ESTADO|<id>\n\n" +
    "2) *Mensaje libre* (yo intento entenderlo)\n" +
    "Ej: \"Agendá Sol 25/2 16:00 particular\" o \"Listar 25/2\".\n"
  );
}

function humanConfirmText({ paciente, fecha, hora, tipo, link, id }) {
  const tipoTxt = tipo || "PARTICULAR";
  return (
    `✅ Listo, lo agendé.\n\n` +
    `👤 ${paciente}\n` +
    `📅 ${fecha} ${hora}\n` +
    `🏷️ ${tipoTxt}\n` +
    `🧾 ID: ${id}\n` +
    (link ? `\n📌 Calendario: ${link}\n` : "")
  );
}

function humanCancelText({ paciente, fecha, hora, id }) {
  return (
    `🗑️ Turno cancelado.\n\n` +
    `👤 ${paciente}\n` +
    `📅 ${fecha} ${hora}\n` +
    `🧾 ID: ${id}\n`
  );
}

function humanRescheduleText({ paciente, oldFecha, oldHora, fecha, hora, id, link }) {
  return (
    `🔁 Turno reprogramado.\n\n` +
    `👤 ${paciente}\n` +
    `Antes: ${oldFecha} ${oldHora}\n` +
    `Ahora: ${fecha} ${hora}\n` +
    `🧾 ID: ${id}\n` +
    (link ? `\n📌 Calendario: ${link}\n` : "")
  );
}

/***********************
 * GOOGLE SHEETS HELPERS
 ***********************/

// Lee toda la tabla (simple y robusto; para volumen chico-mediano va perfecto)
async function readAllTurnos() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: SHEET_RANGE_ALL,
  });

  const rows = res.data.values || [];
  // rows: [ [id, paciente, fecha, hora, tipo, pago, estado, calendar_event_id, nota, created_at], ...]
  return rows;
}

function rowToObj(row) {
  return {
    id: row[0] || "",
    paciente: row[1] || "",
    fecha: row[2] || "",
    hora: row[3] || "",
    tipo: row[4] || "",
    pago: row[5] || "",
    estado: row[6] || "",
    calendar_event_id: row[7] || "",
    nota: row[8] || "",
    created_at: row[9] || "",
  };
}

async function appendTurno(row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: SHEET_RANGE_ALL,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
}

async function updateRowByIndex(rowIndex1Based, newRow) {
  // rowIndex1Based: 1 = primera fila de la hoja (incluyendo encabezados si existieran)
  const range = `${SHEET_NAME}!A${rowIndex1Based}:J${rowIndex1Based}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [newRow] },
  });
}

async function findTurnoById(id) {
  const rows = await readAllTurnos();
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i][0] || "").trim() === id.trim()) {
      return { rowIndex1Based: i + 1, row: rows[i], obj: rowToObj(rows[i]) };
    }
  }
  return null;
}

async function findTurnosByPaciente(name) {
  const needle = upperNoAccents(name);
  const rows = await readAllTurnos();
  const matches = [];
  for (let i = 0; i < rows.length; i++) {
    const paciente = upperNoAccents(rows[i][1] || "");
    if (paciente.includes(needle)) {
      matches.push({ rowIndex1Based: i + 1, row: rows[i], obj: rowToObj(rows[i]) });
    }
  }
  return matches;
}

async function findActiveTurnoSameSlot(paciente, fecha, hora) {
  const p = upperNoAccents(paciente);
  const rows = await readAllTurnos();

  for (let i = 0; i < rows.length; i++) {
    const obj = rowToObj(rows[i]);
    if (!obj.id) continue;
    if (upperNoAccents(obj.paciente) !== p) continue;
    if ((obj.fecha || "").trim() !== fecha) continue;
    if ((obj.hora || "").trim() !== hora) continue;
    if (upperNoAccents(obj.estado) === "ACTIVO") {
      return { rowIndex1Based: i + 1, row: rows[i], obj };
    }
  }
  return null;
}

async function listTurnosByDate(fechaISO) {
  const rows = await readAllTurnos();
  const list = [];
  for (let i = 0; i < rows.length; i++) {
    const obj = rowToObj(rows[i]);
    if (!obj.id) continue;
    if ((obj.fecha || "").trim() === fechaISO) {
      list.push(obj);
    }
  }
  // ordenar por hora
  list.sort((a, b) => (a.hora || "").localeCompare(b.hora || ""));
  return list;
}

/***********************
 * GOOGLE CALENDAR HELPERS
 ***********************/
async function createCalendarEvent({ paciente, fecha, hora, tipo, pago, nota }) {
  // fecha: YYYY-MM-DD, hora: HH:MM (hora local ARG)
  const start = `${fecha}T${hora}:00`;
  const end = `${fecha}T${addMinutesToHHMM(hora, 50)}:00`;

  const descLines = [
    `Tipo: ${tipo || "PARTICULAR"}`,
    `Pago: ${pago || "PENDIENTE"}`,
  ];
  if (nota) descLines.push(`Nota: ${nota}`);

  const ev = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    requestBody: {
      summary: `${paciente} – Psicoterapia`,
      description: descLines.join("\n"),
      start: { dateTime: start, timeZone: TIMEZONE },
      end: { dateTime: end, timeZone: TIMEZONE },
    },
  });

  return { id: ev.data.id, link: ev.data.htmlLink };
}

async function cancelCalendarEvent(eventId) {
  if (!eventId) return;
  try {
    await calendar.events.delete({
      calendarId: CALENDAR_ID,
      eventId,
    });
  } catch (e) {
    // si ya no existe, no rompemos
    console.error("No pude borrar evento calendario:", e?.response?.data || e);
  }
}

async function patchCalendarEventTime(eventId, fecha, hora) {
  if (!eventId) return null;

  const start = `${fecha}T${hora}:00`;
  const end = `${fecha}T${addMinutesToHHMM(hora, 50)}:00`;

  try {
    const ev = await calendar.events.patch({
      calendarId: CALENDAR_ID,
      eventId,
      requestBody: {
        start: { dateTime: start, timeZone: TIMEZONE },
        end: { dateTime: end, timeZone: TIMEZONE },
      },
    });
    return { id: ev.data.id, link: ev.data.htmlLink };
  } catch (e) {
    console.error("No pude reprogramar evento calendario:", e?.response?.data || e);
    return null;
  }
}

async function patchCalendarEventDescription(eventId, { tipo, pago, nota }) {
  if (!eventId) return;
  try {
    // Leemos, actualizamos description
    const current = await calendar.events.get({
      calendarId: CALENDAR_ID,
      eventId,
    });

    const pacienteSummary = current.data.summary || "";
    const descLines = [
      `Tipo: ${tipo || "PARTICULAR"}`,
      `Pago: ${pago || "PENDIENTE"}`,
    ];
    if (nota) descLines.push(`Nota: ${nota}`);

    await calendar.events.patch({
      calendarId: CALENDAR_ID,
      eventId,
      requestBody: {
        summary: pacienteSummary,
        description: descLines.join("\n"),
      },
    });
  } catch (e) {
    console.error("No pude actualizar descripción calendario:", e?.response?.data || e);
  }
}

/***********************
 * NLP / PARSEO DE MENSAJES
 ***********************/
function tryParseFreeText(text) {
  // Devuelve { cmd, args } o null
  const t = normalizeSpaces(text);
  const up = upperNoAccents(t);

  // HELP
  if (["AYUDA", "HELP", "COMANDOS", "MENU"].includes(up)) {
    return { cmd: "AYUDA", args: {} };
  }

  // LISTAR (ej: "listar 25/2")
  if (up.startsWith("LISTAR")) {
    const rest = t.slice(6).trim();
    const fecha = parseDateFlexible(rest);
    return { cmd: "LISTAR", args: { fecha } };
  }

  // BUSCAR (ej: "buscar sol")
  if (up.startsWith("BUSCAR")) {
    const name = t.slice(6).trim();
    return { cmd: "BUSCAR", args: { paciente: name } };
  }

  // CANCELAR (ej: "cancelar <id>")
  if (up.startsWith("CANCELAR")) {
    const id = t.slice(8).trim();
    return { cmd: "CANCELAR", args: { id } };
  }

  // ESTADO (ej: "estado <id>")
  if (up.startsWith("ESTADO")) {
    const id = t.slice(6).trim();
    return { cmd: "ESTADO", args: { id } };
  }

  // NOTA (ej: "nota <id> texto...")
  if (up.startsWith("NOTA")) {
    const rest = t.slice(4).trim();
    const m = rest.match(/^(\S+)\s+(.+)$/);
    if (!m) return { cmd: "NOTA", args: { id: "", nota: "" } };
    return { cmd: "NOTA", args: { id: m[1], nota: m[2] } };
  }

  // PAGADO (ej: "pagado <id> transferencia")
  if (up.startsWith("PAGADO")) {
    const rest = t.slice(6).trim();
    const m = rest.match(/^(\S+)(?:\s+(.+))?$/);
    if (!m) return { cmd: "PAGADO", args: { id: "", detalle: "" } };
    return { cmd: "PAGADO", args: { id: m[1], detalle: m[2] || "" } };
  }

  // REPROGRAMAR (ej: "reprogramar <id> 26/2 17:30")
  if (up.startsWith("REPROGRAMAR") || up.startsWith("REPROG")) {
    const rest = up.startsWith("REPROG") ? t.slice(6).trim() : t.slice(11).trim();
    // esperamos: "<id> <fecha> <hora>"
    const parts = rest.split(" ").filter(Boolean);
    const id = parts[0] || "";
    const fecha = parseDateFlexible(parts[1] || "");
    const hora = parseTimeFlexible(parts[2] || "");
    return { cmd: "REPROGRAMAR", args: { id, fecha, hora } };
  }

  // AGENDAR libre:
  // "agendar Sol 25/2 16:00 particular"
  // "agendá Sol 25-02 16 particular"
  if (up.startsWith("AGENDAR") || up.startsWith("AGEND") || up.startsWith("TURN0") || up.startsWith("TURNO")) {
    // estrategia simple: buscar fecha y hora, lo anterior es nombre, lo posterior es tipo
    const words = t.replace(/[,]/g, " ").split(" ").filter(Boolean);

    // encontrar fecha/hora
    let fecha = null;
    let hora = null;
    let fechaIdx = -1;
    let horaIdx = -1;

    for (let i = 0; i < words.length; i++) {
      const d = parseDateFlexible(words[i]);
      if (d) {
        fecha = d;
        fechaIdx = i;
        break;
      }
    }
    for (let i = 0; i < words.length; i++) {
      const h = parseTimeFlexible(words[i]);
      if (h) {
        hora = h;
        horaIdx = i;
        break;
      }
    }

    // nombre: lo que queda entre el verbo y la fecha/hora
    // verbo suele ser words[0]
    const startIdx = 1;
    const cutIdx = Math.min(
      fechaIdx === -1 ? 999 : fechaIdx,
      horaIdx === -1 ? 999 : horaIdx
    );
    const nameWords = words.slice(startIdx, cutIdx).filter((w) => !/^agend/i.test(w));
    const paciente = normalizeSpaces(nameWords.join(" "));

    // tipo: buscar keywords
    const upAll = upperNoAccents(t);
    let tipo = "PARTICULAR";
    if (upAll.includes("OS") || upAll.includes("OBRA") || upAll.includes("SOCIAL")) tipo = "OS";
    if (upAll.includes("PARTI")) tipo = "PARTICULAR";

    return { cmd: "AGENDAR", args: { paciente, fecha, hora, tipo } };
  }

  return null;
}

/***********************
 * COMMAND HANDLER
 ***********************/
async function handleCommand(text) {
  const raw = normalizeSpaces(text);

  // 1) Si viene con pipes, parseo "duro"
  if (raw.includes("|")) {
    const parts = raw.split("|").map((p) => p.trim());
    const cmd = upperNoAccents(parts[0] || "");

    if (cmd === "AYUDA" || cmd === "HELP" || cmd === "COMANDOS") {
      return friendlyHelp();
    }

    if (cmd === "AGENDAR") {
      const paciente = parts[1];
      const fecha = parts[2];
      const hora = parts[3];
      const tipo = upperNoAccents(parts[4] || "PARTICULAR");

      return await cmdAgendar({ paciente, fecha, hora, tipo });
    }

    if (cmd === "LISTAR") {
      const fecha = parseDateFlexible(parts[1] || "");
      return await cmdListar({ fecha });
    }

    if (cmd === "BUSCAR") {
      const paciente = parts[1] || "";
      return await cmdBuscar({ paciente });
    }

    if (cmd === "CANCELAR") {
      const id = parts[1] || "";
      return await cmdCancelar({ id });
    }

    if (cmd === "REPROGRAMAR") {
      const id = parts[1] || "";
      const fecha = parseDateFlexible(parts[2] || "");
      const hora = parseTimeFlexible(parts[3] || "");
      return await cmdReprogramar({ id, fecha, hora });
    }

    if (cmd === "PAGADO") {
      const id = parts[1] || "";
      const detalle = parts[2] || "";
      return await cmdPagado({ id, detalle });
    }

    if (cmd === "NOTA") {
      const id = parts[1] || "";
      const nota = parts.slice(2).join(" | ").trim();
      return await cmdNota({ id, nota });
    }

    if (cmd === "ESTADO") {
      const id = parts[1] || "";
      return await cmdEstado({ id });
    }

    return (
      "No entendí ese comando 😅\n\n" +
      friendlyHelp()
    );
  }

  // 2) Si no viene con pipes, intento entender texto libre
  const parsed = tryParseFreeText(raw);
  if (!parsed) {
    return (
      "Te leo 👀 pero no estoy seguro de qué querés hacer.\n\n" +
      friendlyHelp()
    );
  }

  switch (parsed.cmd) {
    case "AYUDA":
      return friendlyHelp();

    case "AGENDAR":
      return await cmdAgendar(parsed.args);

    case "LISTAR":
      return await cmdListar(parsed.args);

    case "BUSCAR":
      return await cmdBuscar(parsed.args);

    case "CANCELAR":
      return await cmdCancelar(parsed.args);

    case "REPROGRAMAR":
      return await cmdReprogramar(parsed.args);

    case "PAGADO":
      return await cmdPagado(parsed.args);

    case "NOTA":
      return await cmdNota(parsed.args);

    case "ESTADO":
      return await cmdEstado(parsed.args);

    default:
      return friendlyHelp();
  }
}

/***********************
 * COMMAND IMPLEMENTATIONS
 ***********************/
async function cmdAgendar({ paciente, fecha, hora, tipo }) {
  paciente = normalizeSpaces(paciente);
  fecha = parseDateFlexible(fecha);
  hora = parseTimeFlexible(hora);
  tipo = upperNoAccents(tipo || "PARTICULAR");

  if (!paciente || !fecha || !hora) {
    return (
      "Me falta un dato para agendar 🤔\n\n" +
      "Probá así:\n" +
      "• AGENDAR|Nombre|YYYY-MM-DD|HH:MM|PARTICULAR/OS\n" +
      "Ej: AGENDAR|Sol|2026-02-25|16:00|PARTICULAR\n\n" +
      "O en texto:\n" +
      "• \"Agendá Sol 25/2 16:00 particular\""
    );
  }

  if (!isValidISODate(fecha)) {
    return "La fecha no me cierra 😅 Usá formato YYYY-MM-DD o DD/MM. Ej: 2026-02-25";
  }
  if (!isValidTimeHHMM(hora)) {
    return "La hora no me cierra 😅 Usá HH:MM. Ej: 16:00";
  }

  // dedupe simple: mismo paciente + fecha + hora activo
  const dup = await findActiveTurnoSameSlot(paciente, fecha, hora);
  if (dup) {
    return (
      "Ojo: ya existe un turno *activo* con esos datos.\n\n" +
      `👤 ${dup.obj.paciente}\n📅 ${dup.obj.fecha} ${dup.obj.hora}\n🧾 ID: ${dup.obj.id}\n\n` +
      "Si querés, podés reprogramarlo con:\n" +
      `REPROGRAMAR|${dup.obj.id}|YYYY-MM-DD|HH:MM`
    );
  }

  const pago = "PENDIENTE";
  const estado = "ACTIVO";
  const id = uuidv4();
  const createdAt = nowISO();

  // Creamos evento calendario
  const cal = await createCalendarEvent({
    paciente,
    fecha,
    hora,
    tipo,
    pago,
    nota: "",
  });

  // Guardamos en sheet
  await appendTurno([
    id,
    paciente,
    fecha,
    hora,
    tipo,
    pago,
    estado,
    cal.id || "",
    "",
    createdAt,
  ]);

  return humanConfirmText({
    paciente,
    fecha,
    hora,
    tipo,
    link: cal.link,
    id,
  });
}

async function cmdListar({ fecha }) {
  const f = parseDateFlexible(fecha || "");
  if (!f) {
    return (
      "¿Para qué fecha querés listar? 😊\n\n" +
      "Ej:\n" +
      "• LISTAR|2026-02-25\n" +
      "• \"Listar 25/2\""
    );
  }

  const turnos = await listTurnosByDate(f);
  if (!turnos.length) {
    return `📭 No hay turnos cargados para ${f}.`;
  }

  const activos = turnos.filter((t) => upperNoAccents(t.estado) === "ACTIVO");
  const cancelados = turnos.filter((t) => upperNoAccents(t.estado) !== "ACTIVO");

  let msg = `📅 Turnos ${f}\n`;
  if (activos.length) {
    msg += `\n*Activos*\n`;
    for (const t of activos) {
      msg += `• ${t.hora} — ${t.paciente} (${t.tipo || "PARTICULAR"}) [${t.pago || "PENDIENTE"}]\n  ID: ${t.id}\n`;
    }
  }
  if (cancelados.length) {
    msg += `\n*No activos*\n`;
    for (const t of cancelados) {
      msg += `• ${t.hora} — ${t.paciente} (${t.estado})\n  ID: ${t.id}\n`;
    }
  }

  return msg.trim();
}

async function cmdBuscar({ paciente }) {
  const p = normalizeSpaces(paciente);
  if (!p) {
    return "Decime a quién querés buscar 🙂\nEj: BUSCAR|Sol";
  }

  const matches = await findTurnosByPaciente(p);
  if (!matches.length) return `No encontré turnos para "${p}".`;

  // orden por fecha/hora desc (más reciente arriba)
  matches.sort((a, b) => {
    const ka = `${a.obj.fecha} ${a.obj.hora}`;
    const kb = `${b.obj.fecha} ${b.obj.hora}`;
    return kb.localeCompare(ka);
  });

  const top = matches.slice(0, 8);
  let msg = `🔎 Resultados para "${p}"\n`;
  for (const m of top) {
    const t = m.obj;
    msg += `\n• ${t.fecha} ${t.hora} — ${t.tipo || "PARTICULAR"} — ${t.estado || "-"} — ${t.pago || "-"}\n  ID: ${t.id}`;
  }
  if (matches.length > top.length) {
    msg += `\n\n(Te muestro ${top.length} de ${matches.length}. Si querés, buscá más específico.)`;
  }
  return msg.trim();
}

async function cmdEstado({ id }) {
  id = (id || "").trim();
  if (!id) return "Pasame el ID 🙂\nEj: ESTADO|<id>";

  const found = await findTurnoById(id);
  if (!found) return `No encontré el turno con ID: ${id}`;

  const t = found.obj;
  return (
    `🧾 Estado del turno\n\n` +
    `👤 ${t.paciente}\n` +
    `📅 ${t.fecha} ${t.hora}\n` +
    `🏷️ ${t.tipo || "-"}\n` +
    `💳 ${t.pago || "-"}\n` +
    `📌 ${t.estado || "-"}\n` +
    (t.nota ? `📝 Nota: ${t.nota}\n` : "") +
    `\nID: ${t.id}`
  );
}

async function cmdCancelar({ id }) {
  id = (id || "").trim();
  if (!id) {
    return "Para cancelar necesito el ID.\nEj: CANCELAR|<id>";
  }

  const found = await findTurnoById(id);
  if (!found) return `No encontré el turno con ID: ${id}`;

  const t = found.obj;
  if (upperNoAccents(t.estado) !== "ACTIVO") {
    return `Ese turno ya está en estado "${t.estado || "-"}".`;
  }

  // Actualizamos sheet
  const newRow = [
    t.id,
    t.paciente,
    t.fecha,
    t.hora,
    t.tipo,
    t.pago,
    "CANCELADO",
    t.calendar_event_id,
    t.nota,
    t.created_at,
  ];
  await updateRowByIndex(found.rowIndex1Based, newRow);

  // Borramos calendar event (best effort)
  await cancelCalendarEvent(t.calendar_event_id);

  return humanCancelText({
    paciente: t.paciente,
    fecha: t.fecha,
    hora: t.hora,
    id: t.id,
  });
}

async function cmdReprogramar({ id, fecha, hora }) {
  id = (id || "").trim();
  fecha = parseDateFlexible(fecha || "");
  hora = parseTimeFlexible(hora || "");

  if (!id || !fecha || !hora) {
    return (
      "Para reprogramar necesito: ID + fecha + hora.\n\n" +
      "Ej:\n" +
      "• REPROGRAMAR|<id>|2026-02-26|17:00\n" +
      "o \"Reprogramar <id> 26/2 17:00\""
    );
  }

  if (!isValidISODate(fecha)) return "La fecha no me cierra 😅";
  if (!isValidTimeHHMM(hora)) return "La hora no me cierra 😅";

  const found = await findTurnoById(id);
  if (!found) return `No encontré el turno con ID: ${id}`;

  const t = found.obj;
  if (upperNoAccents(t.estado) !== "ACTIVO") {
    return `No reprogramo porque el turno está "${t.estado || "-"}".`;
  }

  // Evitar duplicado: mismo paciente + nuevo slot ya activo
  const dup = await findActiveTurnoSameSlot(t.paciente, fecha, hora);
  if (dup && dup.obj.id !== id) {
    return (
      "Ese horario ya está ocupado para ese paciente (turno activo).\n\n" +
      `📅 ${dup.obj.fecha} ${dup.obj.hora}\n🧾 ID: ${dup.obj.id}`
    );
  }

  const oldFecha = t.fecha;
  const oldHora = t.hora;

  // Calendario: patch (best effort). Si falla, seguimos igual y avisamos.
  const cal = await patchCalendarEventTime(t.calendar_event_id, fecha, hora);

  // Sheet update
  const newRow = [
    t.id,
    t.paciente,
    fecha,
    hora,
    t.tipo,
    t.pago,
    t.estado,
    t.calendar_event_id,
    t.nota,
    t.created_at,
  ];
  await updateRowByIndex(found.rowIndex1Based, newRow);

  return humanRescheduleText({
    paciente: t.paciente,
    oldFecha,
    oldHora,
    fecha,
    hora,
    id: t.id,
    link: cal?.link || "",
  });
}

async function cmdPagado({ id, detalle }) {
  id = (id || "").trim();
  detalle = normalizeSpaces(detalle || "");

  if (!id) return "Pasame el ID 🙂\nEj: PAGADO|<id>|transferencia";

  const found = await findTurnoById(id);
  if (!found) return `No encontré el turno con ID: ${id}`;

  const t = found.obj;

  const pago = detalle ? `PAGADO (${detalle})` : "PAGADO";
  const newRow = [
    t.id,
    t.paciente,
    t.fecha,
    t.hora,
    t.tipo,
    pago,
    t.estado,
    t.calendar_event_id,
    t.nota,
    t.created_at,
  ];
  await updateRowByIndex(found.rowIndex1Based, newRow);

  // Actualizar descripción del evento calendario (best effort)
  await patchCalendarEventDescription(t.calendar_event_id, {
    tipo: t.tipo,
    pago,
    nota: t.nota,
  });

  return (
    `💳 Perfecto. Marcado como *${pago}*.\n\n` +
    `👤 ${t.paciente}\n📅 ${t.fecha} ${t.hora}\n🧾 ID: ${t.id}`
  );
}

async function cmdNota({ id, nota }) {
  id = (id || "").trim();
  nota = normalizeSpaces(nota || "");

  if (!id || !nota) {
    return "Formato:\n• NOTA|<id>|tu nota\nEj: NOTA|abc123|Trae tema duelo";
  }

  const found = await findTurnoById(id);
  if (!found) return `No encontré el turno con ID: ${id}`;

  const t = found.obj;

  const newRow = [
    t.id,
    t.paciente,
    t.fecha,
    t.hora,
    t.tipo,
    t.pago,
    t.estado,
    t.calendar_event_id,
    nota,
    t.created_at,
  ];
  await updateRowByIndex(found.rowIndex1Based, newRow);

  // Actualizar descripción del evento calendario (best effort)
  await patchCalendarEventDescription(t.calendar_event_id, {
    tipo: t.tipo,
    pago: t.pago,
    nota,
  });

  return (
    `📝 Anotado.\n\n` +
    `👤 ${t.paciente}\n📅 ${t.fecha} ${t.hora}\n🧾 ID: ${t.id}\n` +
    `Nota: ${nota}`
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
 * HEALTH
 ***********************/
app.get("/", (req, res) => {
  res.status(200).send("OK");
});

/***********************
 * WEBHOOK RECEIVE
 ***********************/
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const value = req.body?.entry?.[0]?.changes?.[0]?.value;
  const msg = value?.messages?.[0];
  if (!msg) return;

  const from = msg.from;
  const text = msg.text?.body || "";

  console.log("FROM:", from, "TEXTO:", text);

  const reply = await handleCommand(text);
  const to = ALLOWED_TO || from;

  console.log("[REPLY] to:", to, "from:", from);
  await sendMessage(to, reply);
});

/***********************
 * SERVER
 ***********************/
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log("Bot activo en puerto", PORT));