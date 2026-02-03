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
        const rawBody = req.body;
        // Parseamos el body
        const parsed = qs.parse(rawBody, { depth: 20, allowDots: true, comma: true });

        console.log('Webhook recibido');

        // Validación básica
        if (!parsed.message || !parsed.message.add || !parsed.message.add[0]) {
            return res.sendStatus(200);
        }

        const note = parsed.message.add[0];

        // 1. DETECCIÓN DINÁMICA DEL DOMINIO
        // El JSON trae: "account": { "_links": { "self": "https://juandyna43.amocrm.com" } }
        // Debemos usar EXACTAMENTE ese dominio base.
        let baseDomain = 'kommo.com'; // Fallback
        let accountUrl = '';
        
        if (parsed.account && parsed.account._links && parsed.account._links.self) {
            accountUrl = parsed.account._links.self; // Ej: https://juandyna43.amocrm.com
            // Eliminamos https:// para obtener solo el host
            baseDomain = accountUrl.replace('https://', '').replace(/\/$/, '');
        } else {
            // Si no viene en el webhook, usa tu variable de entorno
            baseDomain = 'juandyna43.amocrm.com'; 
        }

        console.log(`Usando dominio: ${baseDomain}`);

        const messageData = {
            text: note.text,
            chat_id: note.chat_id,
            element_id: note.element_id, 
            talk_id: note.talk_id,       
            contact_id: note.contact_id, 
            author_id: note.author.id,
            account_id: parsed.account.id 
        };

        // Evitar bucles (no respondernos a nosotros mismos)
        if (!messageData.text || messageData.text === '' || note.type === 'outgoing') {
            return res.sendStatus(200);
        }
        
        // Respuesta simple del Bot
        const userMessage = messageData.text.toLowerCase();
        let respuestaBot = 'Recibido. Un asesor te contactará.';
        if (userMessage.includes('hola')) respuestaBot = '¡Hola! ¿En qué puedo ayudarte?';

        // ---------------------------------------------------------
        // PASO 1: OBTENER TOKEN DE SESIÓN (AJAX)
        // ---------------------------------------------------------
        console.log('Solicitando token de chat...');

        // NOTA: Es crucial añadir headers que simulen ser un navegador
        // y usar el dominio correcto (amocrm.com o kommo.com)
        const sessionUrl = `https://${baseDomain}/ajax/v1/chats/session`;

        const sessionResponse = await axios.post(
            sessionUrl,
            qs.stringify({
                'request[chats][session][action]': 'create'
            }),
            {
                headers: {
                    'X-Requested-With': 'XMLHttpRequest',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': `Bearer ${ACCESS_TOKEN}`,
                    // Headers Anti-bloqueo 403:
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Referer': `https://${baseDomain}/leads/detail/${messageData.element_id}`,
                    'Origin': `https://${baseDomain}`
                }
            }
        );

        if (!sessionResponse.data || !sessionResponse.data.response) {
            throw new Error('No se recibió data válida en la sesión');
        }

        const sessionData = sessionResponse.data.response.chats.session;
        const amojoAccessToken = sessionData.access_token;
        const personaName = sessionData.user.name;
        const personaAvatar = sessionData.user.avatar;
        // Importante: Usar el ID de cuenta que devuelve la sesión
        const sessionAccountId = sessionData.account.id; 

        console.log('Token obtenido. Enviando mensaje a AmoJo...');

        // ---------------------------------------------------------
        // PASO 2: ENVIAR MENSAJE A AMOJO
        // ---------------------------------------------------------
        
        const amojoUrl = `https://amojo.kommo.com/v1/chats/${sessionAccountId}/${messageData.chat_id}/messages`;

        const messagePayload = {
            silent: 'false',
            priority: 'low',
            'crm_entity[id]': messageData.element_id,
            'crm_entity[type]': '2', // Lead
            persona_name: personaName,
            persona_avatar: personaAvatar,
            text: respuestaBot,
            recipient_id: messageData.author_id,
            crm_dialog_id: messageData.talk_id,
            crm_contact_id: messageData.contact_id,
            crm_account_id: messageData.account_id,
            skip_link_shortener: 'true'
        };

        await axios.post(
            amojoUrl,
            qs.stringify(messagePayload),
            {
                headers: {
                    'X-Requested-With': 'XMLHttpRequest',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'X-Auth-Token': amojoAccessToken,
                    'chatId': messageData.chat_id,
                    // Headers extra por seguridad
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Origin': `https://${baseDomain}`
                }
            }
        );

        console.log('Mensaje enviado con éxito.');
        res.sendStatus(200);

    } catch (err) {
        console.error('Error procesando webhook:');
        if (err.response) {
            console.error(`Status: ${err.response.status}`);
            // Mostramos solo una parte del error para no llenar la consola de HTML
            const dataStr = typeof err.response.data === 'object' ? JSON.stringify(err.response.data) : err.response.data.toString().substring(0, 200);
            console.error('Data Resumen:', dataStr);
        } else {
            console.error(err.message);
        }
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