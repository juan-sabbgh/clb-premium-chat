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
        // 1. PARSEO DE DATOS (Igual que en tu código original)
        const rawBody = req.body;
        const parsed = qs.parse(rawBody, { depth: 20, allowDots: true, comma: true });

        console.log('Webhook recibido:', JSON.stringify(parsed, null, 2));

        // Verificación básica
        if (!parsed.message || !parsed.message.add || !parsed.message.add[0]) {
            console.log('No es un mensaje entrante válido.');
            return res.sendStatus(200);
        }

        const note = parsed.message.add[0];

        // 2. EXTRACCIÓN DE DATOS (Necesarios para replicar el nodo de n8n)
        // El nodo n8n usa: element_id, talk_id, contact_id, account[id], chat_id
        const messageData = {
            text: note.text,
            chat_id: note.chat_id,
            element_id: note.element_id, // ID del Lead
            talk_id: note.talk_id,       // ID de la conversación
            contact_id: note.contact_id, // ID del contacto
            author_id: note.author.id,   // ID de quien envía
            account_id: parsed.account.id // ID de la cuenta global
        };

        if (!messageData.text || !messageData.chat_id) {
            return res.sendStatus(200);
        }

        // Lógica simple de respuesta (Tu IA o lógica condicional)
        const userMessage = (messageData.text || '').toLowerCase().trim();
        let respuestaBot = 'No entendí, ¿puedes repetir?';
        
        if (userMessage.includes('hola')) {
            respuestaBot = '¡Hola! Soy el vendedor de Jerseys. ¿Qué buscas hoy?';
        } else {
            respuestaBot = `Recibí tu mensaje: "${messageData.text}". En breve te atiendo.`;
        }

        // ---------------------------------------------------------
        // PASO 3: REPLICAR NODO "Get token" (n8n)
        // URL: https://[subdomain].kommo.com/ajax/v1/chats/session
        // ---------------------------------------------------------
        console.log('Obteniendo token de sesión de chat...');
        
        const sessionUrl = `https://${KOMMO_SUBDOMAIN}.kommo.com/ajax/v1/chats/session`;
        
        const sessionResponse = await axios.post(
            sessionUrl,
            qs.stringify({
                'request[chats][session][action]': 'create'
            }),
            {
                headers: {
                    'X-Requested-With': 'XMLHttpRequest',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    // Importante: Usamos el token Bearer para autenticar esta petición AJAX
                    'Authorization': `Bearer ${ACCESS_TOKEN}`, 
                    // A veces Kommo requiere simular Cookies o User-Agent, 
                    // pero con el Bearer suele bastar para este endpoint.
                }
            }
        );

        // Extraemos la info necesaria de la respuesta del token
        // n8n path: $json.response.chats.session.access_token
        const sessionData = sessionResponse.data.response.chats.session;
        const amojoAccessToken = sessionData.access_token;
        const personaName = sessionData.user.name;
        const personaAvatar = sessionData.user.avatar;
        // n8n usa account.id del session response, aunque ya lo tenemos del webhook
        const sessionAccountId = sessionData.account.id; 

        console.log('Token de chat obtenido con éxito.');

        // ---------------------------------------------------------
        // PASO 4: REPLICAR NODO "Enviar el mensaje" (n8n)
        // URL: https://amojo.kommo.com/v1/chats/[account_id]/[chat_id]/messages
        // ---------------------------------------------------------
        
        const amojoUrl = `https://amojo.kommo.com/v1/chats/${sessionAccountId}/${messageData.chat_id}/messages`;

        // Construimos el body tal cual lo hace n8n (form-urlencoded)
        const messagePayload = {
            silent: 'false',
            priority: 'low',
            'crm_entity[id]': messageData.element_id, // Lead ID donde se guarda
            'crm_entity[type]': '2', // 2 = Lead
            persona_name: personaName,
            persona_avatar: personaAvatar,
            text: respuestaBot, // La respuesta generada
            recipient_id: messageData.author_id,
            crm_dialog_id: messageData.talk_id,
            crm_contact_id: messageData.contact_id,
            crm_account_id: messageData.account_id,
            skip_link_shortener: 'true'
        };

        await axios.post(
            amojoUrl,
            qs.stringify(messagePayload), // Axios no stringify por defecto a form-urlencoded complejo
            {
                headers: {
                    'X-Requested-With': 'XMLHttpRequest',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'X-Auth-Token': amojoAccessToken, // Token obtenido en el paso anterior
                    'chatId': messageData.chat_id
                }
            }
        );

        console.log(`Respuesta enviada correctamente al chat ${messageData.chat_id}`);
        res.sendStatus(200);

    } catch (err) {
        // Manejo de errores detallado para depuración
        console.error('Error en el proceso:');
        if (err.response) {
            console.error(`Status: ${err.response.status}`);
            console.error('Data:', JSON.stringify(err.response.data, null, 2));
        } else {
            console.error(err.message);
        }
        res.sendStatus(200); // Siempre devolver 200 a Kommo
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