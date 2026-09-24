"use strict";
/**
 * Thin wrapper around Baileys (an UNOFFICIAL WhatsApp Web protocol
 * library - not Meta's Cloud API). This exists only because Meta's
 * official WhatsApp Business Platform has no group-send capability at
 * all. Using this violates WhatsApp's Terms of Service and carries a
 * real ban risk for the connected number - that's a business decision
 * made outside this code, not something this file tries to hide or
 * minimize.
 *
 * Keeps exactly one persistent socket alive, auto-reconnecting on drop
 * (except after an explicit logout, which requires a fresh QR scan).
 */

const path = require("path");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const QRCode = require("qrcode");
const pino = require("pino");

function createWhatsappManager({ authStateDir, logLevel }) {
  const logger = pino({ level: logLevel || "info" });
  const baileysLogger = pino({ level: "warn" }); // Baileys itself is very chatty on "info"

  const state = {
    sock: null,
    connectionState: "disconnected", // disconnected | connecting | qr_pending | connected
    qrDataUrl: null,
    phoneNumber: null,
    lastError: null,
  };

  async function start() {
    state.connectionState = "connecting";
    const { state: authState, saveCreds } = await useMultiFileAuthState(
      path.resolve(authStateDir)
    );
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: authState,
      logger: baileysLogger,
      // Printing the QR to the terminal too is handy for first-time setup
      // over SSH without needing to hit the HTTP endpoint.
      printQRInTerminal: true,
    });
    state.sock = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        state.connectionState = "qr_pending";
        try {
          state.qrDataUrl = await QRCode.toDataURL(qr);
        } catch (err) {
          logger.error({ err }, "Failed to render QR code to a data URL");
        }
      }

      if (connection === "open") {
        state.connectionState = "connected";
        state.qrDataUrl = null;
        state.lastError = null;
        state.phoneNumber = sock.user && sock.user.id ? sock.user.id.split(":")[0] : null;
        logger.info({ phoneNumber: state.phoneNumber }, "WhatsApp group bot connected");
      }

      if (connection === "close") {
        const statusCode =
          lastDisconnect &&
          lastDisconnect.error &&
          lastDisconnect.error.output &&
          lastDisconnect.error.output.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        state.connectionState = "disconnected";
        state.lastError = lastDisconnect && lastDisconnect.error ? String(lastDisconnect.error) : null;
        logger.warn({ statusCode, loggedOut }, "WhatsApp group bot connection closed");

        if (loggedOut) {
          // Session was invalidated (logged out from the phone, or banned).
          // Requires a brand-new QR scan - do NOT auto-reconnect in a loop,
          // that would just spam WhatsApp's servers.
          state.qrDataUrl = null;
          logger.error(
            "Session logged out - delete AUTH_STATE_DIR and restart this service to pair again."
          );
        } else {
          // Transient drop (network blip, restart, etc.) - reconnect.
          setTimeout(() => start().catch((err) => logger.error({ err }, "Reconnect failed")), 3000);
        }
      }
    });

    return sock;
  }

  function getStatus() {
    return {
      state: state.connectionState,
      connected: state.connectionState === "connected",
      phone_number: state.phoneNumber,
      last_error: state.lastError,
    };
  }

  function getQr() {
    return state.qrDataUrl;
  }

  /**
   * Lists every group the paired number is currently a participant in -
   * the practical way to discover a group's real JID for registering it
   * in Odoo, instead of digging through logs.
   */
  async function listGroups() {
    if (state.connectionState !== "connected" || !state.sock) {
      const err = new Error("WhatsApp group bot is not connected (state=" + state.connectionState + ")");
      err.code = "NOT_CONNECTED";
      throw err;
    }
    const groups = await state.sock.groupFetchAllParticipating();
    return Object.values(groups).map((g) => ({
      id: g.id,
      name: g.subject,
      participant_count: Array.isArray(g.participants) ? g.participants.length : null,
    }));
  }

  /**
   * Sends a text and/or media message to a WhatsApp Group.
   * `groupId` must be the full JID, e.g. "120363xxxxxxxxxx@g.us".
   * `media`: optional { base64, mimeType, fileName, mediaType } where
   * mediaType is one of image|video|document.
   */
  async function sendGroupMessage(groupId, text, media) {
    if (state.connectionState !== "connected" || !state.sock) {
      const err = new Error("WhatsApp group bot is not connected (state=" + state.connectionState + ")");
      err.code = "NOT_CONNECTED";
      throw err;
    }
    if (!groupId || !groupId.endsWith("@g.us")) {
      const err = new Error(
        "groupId must be a full WhatsApp group JID ending in '@g.us', got: " + groupId
      );
      err.code = "INVALID_GROUP_ID";
      throw err;
    }

    let content;
    if (media && media.base64) {
      const buffer = Buffer.from(media.base64, "base64");
      if (media.mediaType === "image") {
        content = { image: buffer, caption: text || undefined, mimetype: media.mimeType };
      } else if (media.mediaType === "video") {
        content = { video: buffer, caption: text || undefined, mimetype: media.mimeType };
      } else {
        content = {
          document: buffer,
          fileName: media.fileName || "attachment",
          mimetype: media.mimeType || "application/octet-stream",
          caption: text || undefined,
        };
      }
    } else {
      if (!text) {
        const err = new Error("Either text or media is required");
        err.code = "EMPTY_MESSAGE";
        throw err;
      }
      content = { text };
    }

    const result = await state.sock.sendMessage(groupId, content);
    return { messageId: result && result.key ? result.key.id : null };
  }

  return { start, getStatus, getQr, listGroups, sendGroupMessage };
}

module.exports = { createWhatsappManager };
