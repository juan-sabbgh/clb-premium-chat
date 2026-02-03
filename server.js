const express = require('express');
const axios = require('axios');
const qs = require('qs');
require('dotenv').config();

const app = express();

app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(express.json({ limit: '10mb' }));

const KOMMO_SUBDOMAIN = process.env.KOMMO_SUBDOMAIN;
const ACCESS_TOKEN = process.env.KOMMO_ACCESS_TOKEN;
const API_WAZZUP = process.env.API_WAZZUP;

// Webhook endpoint
app.post('/kommo-webhook', async (req, res) => {
    try {
        // 1. Parsear el body (ya viene parseado por urlencoded, pero qs ayuda con nesting profundo)
        const rawBody = req.body; // ya es objeto gracias a express.urlencoded
        console.log(`Raw body: ${rawBody}`);
        const parsed = qs.parse(rawBody, { depth: 20, allowDots: true, comma: true });

        console.log('Webhook recibido (parsed):', JSON.stringify(parsed, null, 2));

        // 2. Detectar si es un evento de mensaje entrante (estructura típica de webhook general)
        // Ejemplo común: notes[add][0][note_type] === 'message' o 'common'
        // o directamente 'message' en algunos casos
        let messageData = null;

        if (parsed.message && parsed.message.add && parsed.message.add[0]) {
            const note = parsed.message.add[0];
            messageData = {
                text: note.text,
                chat_id: note.chat_id,
                contact_id: note.author.id,
                // ... puedes extraer más
            };

        }

        console.log(messageData);

        if (!messageData || !messageData.text) {
            console.log('No es un mensaje entrante o no tiene texto → ignorado');
            return res.sendStatus(200);
        }

        const chatId = messageData.chat_id;
        if (!chatId) {
            console.log('No se encontró chat_id → no se puede responder');
            return res.sendStatus(200);
        }

        const userMessage = (messageData.text || '').toLowerCase().trim();

        // 3. Lógica simple del bot (reemplaza con LLM cuando quieras)
        let respuesta = 'No entendí, ¿puedes repetir por favor?';
        if (userMessage.includes('hola') || userMessage.includes('buenos') || userMessage.includes('qué tal')) {
            respuesta = '¡Hola! ¿En qué te puedo ayudar hoy? 😊';
        } else if (userMessage.includes('cotizar') || userMessage.includes('precio') || userMessage.includes('cuánto cuesta')) {
            respuesta = '¡Claro! Dime qué producto o servicio te interesa y te paso los precios actualizados.';
        }

        console.log(`Respuesta del bot ${respuesta}`);

        // 4. Enviar respuesta vía API de Kommo
        await axios.post(
            `https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4/chats/messages`,
            {
                chat_id: chatId,
                text: respuesta,
                type: 'text',
                // Opcional: from: 'bot' para que aparezca como Salesbot
            },
            {
                headers: {
                    Authorization: `Bearer ${ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        console.log(`Respuesta enviada a chat ${chatId}: ${respuesta}`);

        res.sendStatus(200);
    } catch (err) {
        console.error('Error procesando webhook:', err.message);
        // SIEMPRE responder 200 para que Kommo no reintente infinitamente
        res.sendStatus(200);
    }
});

app.post('/wazzup-webhook', async (req, res) => {
    try {
        const rawBody = req.body;

        // 1. Validar que exista el array de mensajes
        /*if (!rawBody.messages || rawBody.messages.length === 0) {
            return res.sendStatus(200);
        }*/

        const msg = rawBody.messages[0];

        // --- EL FILTRO ANTI-LOOP (CRÍTICO) ---
        // Usamos dos condiciones basadas en TU JSON:
        // A. Si msg.isEcho es true, significa que es un mensaje enviado por ti (o el bot).
        // B. Si msg.status NO es 'inbound', no nos interesa.
        if (msg.isEcho === true || msg.status !== 'inbound') {
            console.log(`Mensaje saliente o echo ignorado. (isEcho: ${msg.isEcho})`);
            return res.sendStatus(200);
        }

        console.log(`Mensaje entrante REAL: ${msg.text}`);

        // 2. Extraer datos
        const messageData = {
            text: msg.text,
            chatId: msg.chatId,
            channelId: msg.channelId,
        };

        // 3. Validar que tenga texto (ignorar fotos solas o audios por ahora)
        if (!messageData.text) {
            return res.sendStatus(200);
        }

        // --- TU LÓGICA DEL BOT ---
        const respuesta = "Holaaa 123";

        // 4. Enviar mensaje
        await axios.post(
            'https://api.wazzup24.com/v3/message',
            {
                channelId: messageData.channelId,
                chatType: "whatsapp",
                chatId: messageData.chatId,
                text: respuesta
            },
            {
                headers: {
                    'Authorization': `Bearer ${API_WAZZUP}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        console.log(`Respuesta enviada a ${messageData.chatId}`);
        res.sendStatus(200);

    } catch (err) {
        console.error('Error:', err.message);
        res.sendStatus(200);
    }
});

// Si pruebas local: 
app.listen(3000, () => console.log('Escuchando en puerto 3000'));